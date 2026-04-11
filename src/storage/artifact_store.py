"""
Artifact Store — Local Filesystem Artifact Management

Manages experiment artifacts (model checkpoints, output files, logs)
on the local filesystem with PostgreSQL metadata tracking.

Directory structure:
    {base_path}/
        {experiment_id}/
            logs/
                stdout.log
                stderr.log
            checkpoints/
                epoch_{n}.pt
            outputs/
                <user files>

The interface is designed to be swappable with S3-compatible storage
by keeping storage operations behind a clean async API.
"""
import asyncio
import hashlib
import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Any, List, Optional

from .database import Database
from .models import Artifact

logger = logging.getLogger(__name__)

DEFAULT_BASE_PATH = os.environ.get("ARTIFACT_BASE_PATH", "/app/artifacts")


class ArtifactStore:
    """
    Filesystem-backed artifact store with PostgreSQL metadata index.

    All artifact paths are absolute on the container filesystem.
    File operations are run in a thread pool to avoid blocking the event loop.
    """

    def __init__(self, db: Database, base_path: str = DEFAULT_BASE_PATH):
        self.db = db
        self.base_path = Path(base_path)

    async def initialize(self):
        """Ensure base artifact directory exists."""
        try:
            await asyncio.to_thread(self.base_path.mkdir, parents=True, exist_ok=True)
            logger.info(f"Artifact store initialized at {self.base_path}")
        except Exception as e:
            logger.warning(f"Failed to create artifact directory: {e}")

    def experiment_dir(self, experiment_id: str) -> Path:
        """Return the root directory for an experiment's artifacts."""
        return self.base_path / experiment_id

    def logs_dir(self, experiment_id: str) -> Path:
        return self.experiment_dir(experiment_id) / "logs"

    def checkpoints_dir(self, experiment_id: str) -> Path:
        return self.experiment_dir(experiment_id) / "checkpoints"

    def outputs_dir(self, experiment_id: str) -> Path:
        return self.experiment_dir(experiment_id) / "outputs"

    async def ensure_experiment_dirs(self, experiment_id: str):
        """Create directory structure for a new experiment."""
        dirs = [
            self.logs_dir(experiment_id),
            self.checkpoints_dir(experiment_id),
            self.outputs_dir(experiment_id),
        ]
        def _mkdirs():
            for d in dirs:
                d.mkdir(parents=True, exist_ok=True)
        try:
            await asyncio.to_thread(_mkdirs)
        except Exception as e:
            logger.warning(f"Failed to create experiment dirs for {experiment_id}: {e}")

    async def save_log(
        self,
        experiment_id: str,
        stream_type: str,  # stdout or stderr
        content: str,
    ) -> Optional[str]:
        """
        Persist stdout/stderr content to a log file.
        Returns the absolute file path.
        """
        log_dir = self.logs_dir(experiment_id)
        file_path = log_dir / f"{stream_type}.log"

        def _write():
            log_dir.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding="utf-8")
            return str(file_path)

        try:
            path = await asyncio.to_thread(_write)
            # Register as artifact
            await self._register_artifact(
                experiment_id=experiment_id,
                name=f"{stream_type}.log",
                artifact_type="log",
                file_path=path,
                metadata={"stream": stream_type},
            )
            return path
        except Exception as e:
            logger.warning(f"Failed to save {stream_type} log: {e}")
            return None

    async def register_checkpoint(
        self,
        experiment_id: str,
        epoch: int,
        source_path: str,
        step: Optional[int] = None,
        metrics: Optional[Dict[str, float]] = None,
        copy: bool = True,
    ) -> Optional[str]:
        """
        Register a model checkpoint file.

        If copy=True, the file is copied into the artifact store.
        Returns the stored file path.
        """
        dest_dir = self.checkpoints_dir(experiment_id)
        source = Path(source_path)
        dest = dest_dir / f"epoch_{epoch:04d}{source.suffix or '.pt'}"

        def _copy():
            dest_dir.mkdir(parents=True, exist_ok=True)
            if copy and source.exists():
                shutil.copy2(str(source), str(dest))
                return str(dest)
            elif not copy:
                return str(source)
            return None

        try:
            file_path = await asyncio.to_thread(_copy)
            if not file_path:
                return None

            file_size = await asyncio.to_thread(lambda: Path(file_path).stat().st_size if Path(file_path).exists() else None)

            await self._register_artifact(
                experiment_id=experiment_id,
                name=f"checkpoint_epoch_{epoch}",
                artifact_type="checkpoint",
                file_path=file_path,
                file_size=file_size,
                metadata={
                    "epoch": epoch,
                    "step": step,
                    "metrics": metrics or {},
                },
            )

            # Also register in checkpoints table
            if self.db.is_connected:
                try:
                    import asyncpg
                    await self.db.execute(
                        """
                        INSERT INTO checkpoints (experiment_id, epoch, step, file_path, file_size, metrics)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        ON CONFLICT DO NOTHING
                        """,
                        uuid.UUID(experiment_id), epoch, step, file_path,
                        file_size, metrics or {},
                    )
                except Exception as e:
                    logger.warning(f"Failed to register checkpoint in DB: {e}")

            return file_path
        except Exception as e:
            logger.warning(f"Failed to register checkpoint: {e}")
            return None

    async def scan_outputs(
        self,
        experiment_id: str,
        scan_path: Optional[str] = None,
    ) -> List[Artifact]:
        """
        Scan a directory for output files and register them as artifacts.
        Defaults to scanning the experiment's outputs directory.

        Returns list of newly registered artifacts.
        """
        scan_dir = Path(scan_path) if scan_path else self.outputs_dir(experiment_id)

        def _scan() -> List[Dict[str, Any]]:
            if not scan_dir.exists():
                return []
            files = []
            for f in scan_dir.rglob("*"):
                if f.is_file():
                    stat = f.stat()
                    files.append({
                        "path": str(f),
                        "name": f.name,
                        "size": stat.st_size,
                        "suffix": f.suffix.lower(),
                    })
            return files

        try:
            files = await asyncio.to_thread(_scan)
        except Exception as e:
            logger.warning(f"Failed to scan outputs: {e}")
            return []

        artifacts = []
        for file_info in files:
            artifact_type = self._infer_artifact_type(file_info["suffix"])
            artifact = await self._register_artifact(
                experiment_id=experiment_id,
                name=file_info["name"],
                artifact_type=artifact_type,
                file_path=file_info["path"],
                file_size=file_info["size"],
            )
            if artifact:
                artifacts.append(artifact)

        return artifacts

    async def get_artifacts(self, experiment_id: str) -> List[Dict[str, Any]]:
        """List all registered artifacts for an experiment."""
        if not self.db.is_connected:
            return []
        try:
            rows = await self.db.fetch(
                """
                SELECT id::text, experiment_id::text, name, artifact_type,
                       file_path, file_size, metadata, version, created_at
                FROM artifacts
                WHERE experiment_id = $1
                ORDER BY created_at ASC
                """,
                uuid.UUID(experiment_id),
            )
            return [dict(row) for row in rows]
        except Exception as e:
            logger.warning(f"Failed to fetch artifacts: {e}")
            return []

    async def get_artifact(self, artifact_id: str) -> Optional[Dict[str, Any]]:
        """Get a single artifact by ID."""
        if not self.db.is_connected:
            return None
        try:
            row = await self.db.fetchrow(
                "SELECT * FROM artifacts WHERE id = $1",
                uuid.UUID(artifact_id),
            )
            return dict(row) if row else None
        except Exception as e:
            logger.warning(f"Failed to fetch artifact {artifact_id}: {e}")
            return None

    async def delete_experiment_artifacts(self, experiment_id: str):
        """Delete all artifact files and DB records for an experiment."""
        exp_dir = self.experiment_dir(experiment_id)

        def _rm():
            if exp_dir.exists():
                shutil.rmtree(str(exp_dir), ignore_errors=True)

        try:
            await asyncio.to_thread(_rm)
        except Exception as e:
            logger.warning(f"Failed to delete artifact files: {e}")

        # DB records cascade-delete via FK when experiment is deleted

    async def cleanup_old_artifacts(
        self,
        max_age_days: int = 30,
        max_total_bytes: Optional[int] = None,
    ) -> int:
        """
        Delete artifacts older than max_age_days.
        Optionally enforce a total storage cap (deletes oldest first).
        Returns count of deleted artifacts.
        """
        if not self.db.is_connected:
            return 0

        cutoff = datetime.utcnow() - timedelta(days=max_age_days)
        deleted = 0

        try:
            # Find old artifacts
            rows = await self.db.fetch(
                """
                SELECT id::text, file_path FROM artifacts
                WHERE created_at < $1
                ORDER BY created_at ASC
                """,
                cutoff,
            )

            for row in rows:
                await self._delete_artifact_file(row["file_path"])
                await self.db.execute(
                    "DELETE FROM artifacts WHERE id = $1",
                    uuid.UUID(row["id"]),
                )
                deleted += 1

            if deleted > 0:
                logger.info(f"Cleaned up {deleted} old artifacts")
        except Exception as e:
            logger.warning(f"Artifact cleanup failed: {e}")

        return deleted

    async def get_storage_stats(self) -> Dict[str, Any]:
        """Return storage usage statistics."""
        def _disk_usage():
            if not self.base_path.exists():
                return 0
            total = 0
            for f in self.base_path.rglob("*"):
                if f.is_file():
                    try:
                        total += f.stat().st_size
                    except OSError:
                        pass
            return total

        disk_bytes = 0
        try:
            disk_bytes = await asyncio.to_thread(_disk_usage)
        except Exception:
            pass

        artifact_count = 0
        if self.db.is_connected:
            try:
                artifact_count = await self.db.fetchval("SELECT COUNT(*) FROM artifacts") or 0
            except Exception:
                pass

        return {
            "base_path": str(self.base_path),
            "total_bytes": disk_bytes,
            "total_mb": round(disk_bytes / 1024 / 1024, 2),
            "artifact_count": artifact_count,
            "writable": os.access(str(self.base_path), os.W_OK) if self.base_path.exists() else False,
        }

    # ---- Internal -------------------------------------------------------

    async def _register_artifact(
        self,
        experiment_id: str,
        name: str,
        artifact_type: str,
        file_path: str,
        file_size: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[Artifact]:
        """Insert artifact record into PostgreSQL."""
        artifact_id = str(uuid.uuid4())
        now = datetime.utcnow()

        if self.db.is_connected:
            try:
                await self.db.execute(
                    """
                    INSERT INTO artifacts (id, experiment_id, name, artifact_type, file_path, file_size, metadata, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT DO NOTHING
                    """,
                    uuid.UUID(artifact_id),
                    uuid.UUID(experiment_id),
                    name,
                    artifact_type,
                    file_path,
                    file_size,
                    metadata or {},
                    now,
                )
            except Exception as e:
                logger.warning(f"Failed to register artifact in DB: {e}")

        return Artifact(
            id=artifact_id,
            experiment_id=experiment_id,
            name=name,
            artifact_type=artifact_type,
            file_path=file_path,
            file_size=file_size,
            metadata=metadata or {},
            created_at=now,
        )

    async def _delete_artifact_file(self, file_path: str):
        """Delete a single artifact file from disk."""
        def _rm():
            p = Path(file_path)
            if p.exists():
                p.unlink()
        try:
            await asyncio.to_thread(_rm)
        except Exception as e:
            logger.debug(f"Failed to delete artifact file {file_path}: {e}")

    @staticmethod
    def _infer_artifact_type(suffix: str) -> str:
        """Guess artifact type from file extension."""
        image_exts = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
        model_exts = {".pt", ".pth", ".ckpt", ".pkl", ".safetensors", ".onnx"}
        data_exts = {".csv", ".json", ".jsonl", ".parquet", ".h5", ".hdf5", ".npz", ".npy"}
        if suffix in image_exts:
            return "image"
        if suffix in model_exts:
            return "checkpoint"
        if suffix in data_exts:
            return "data"
        if suffix in {".log", ".txt"}:
            return "log"
        return "output"
