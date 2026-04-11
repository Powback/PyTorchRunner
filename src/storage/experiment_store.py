"""
Experiment Store — PostgreSQL CRUD for Experiment Runs

Provides persistent storage, querying, and full-text search
for PyTorchRunner experiment records.
"""
import uuid
import logging
from datetime import datetime
from typing import List, Optional, Dict, Any

from .database import Database
from .models import ExperimentRun, ExperimentConfig, ExperimentListItem, Artifact, ModelCheckpoint

logger = logging.getLogger(__name__)


class ExperimentStore:
    """
    CRUD operations for experiment records backed by PostgreSQL.
    All methods return None / [] gracefully when DB is unavailable.
    """

    def __init__(self, db: Database):
        self.db = db

    async def create(self, job_data: Dict[str, Any]) -> Optional[str]:
        """
        Persist a new experiment from a job submission dict.
        Returns experiment ID or None if DB unavailable.
        """
        if not self.db.is_connected:
            return None

        exp_id = job_data.get("job_id", str(uuid.uuid4()))
        name = job_data.get("job_name") or f"job-{exp_id[:8]}"

        try:
            await self.db.execute(
                """
                INSERT INTO experiments (
                    id, name, script, args, cwd, env_vars,
                    status, progress, tags, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11
                )
                ON CONFLICT (id) DO NOTHING
                """,
                uuid.UUID(exp_id),
                name,
                job_data.get("script", ""),
                job_data.get("args", []),
                job_data.get("cwd", ""),
                job_data.get("env_vars", {}),
                job_data.get("status", "queued"),
                float(job_data.get("progress", 0.0)),
                job_data.get("tags", []),
                datetime.utcnow(),
                datetime.utcnow(),
            )
            return exp_id
        except Exception as e:
            logger.warning(f"Failed to persist experiment {exp_id}: {e}")
            return None

    async def update_status(
        self,
        experiment_id: str,
        status: str,
        progress: float,
        exit_code: Optional[int] = None,
        error: Optional[str] = None,
    ):
        """Update experiment status and progress."""
        if not self.db.is_connected:
            return

        try:
            if status == "running":
                await self.db.execute(
                    """
                    UPDATE experiments
                    SET status = $2, progress = $3, started_at = COALESCE(started_at, $4),
                        updated_at = $4
                    WHERE id = $1
                    """,
                    uuid.UUID(experiment_id), status, progress, datetime.utcnow(),
                )
            elif status in ("completed", "failed", "cancelled"):
                await self.db.execute(
                    """
                    UPDATE experiments
                    SET status = $2, progress = $3, exit_code = $4,
                        error = $5, completed_at = $6, updated_at = $6
                    WHERE id = $1
                    """,
                    uuid.UUID(experiment_id), status, progress,
                    exit_code, error, datetime.utcnow(),
                )
            else:
                await self.db.execute(
                    """
                    UPDATE experiments
                    SET status = $2, progress = $3, updated_at = $4
                    WHERE id = $1
                    """,
                    uuid.UUID(experiment_id), status, progress, datetime.utcnow(),
                )
        except Exception as e:
            logger.warning(f"Failed to update experiment {experiment_id}: {e}")

    async def update_output_preview(
        self,
        experiment_id: str,
        stdout_preview: str,
        stderr_preview: str,
        stdout_path: Optional[str] = None,
        stderr_path: Optional[str] = None,
    ):
        """Update output previews and log file paths."""
        if not self.db.is_connected:
            return
        try:
            await self.db.execute(
                """
                UPDATE experiments
                SET stdout_preview = $2, stderr_preview = $3,
                    stdout_path = COALESCE($4, stdout_path),
                    stderr_path = COALESCE($5, stderr_path),
                    updated_at = NOW()
                WHERE id = $1
                """,
                uuid.UUID(experiment_id),
                stdout_preview[-2000:] if stdout_preview else "",
                stderr_preview[-2000:] if stderr_preview else "",
                stdout_path,
                stderr_path,
            )
        except Exception as e:
            logger.warning(f"Failed to update output preview for {experiment_id}: {e}")

    async def update_metrics_summary(
        self, experiment_id: str, metrics: Dict[str, Any]
    ):
        """Update the metrics summary (last known values)."""
        if not self.db.is_connected:
            return
        try:
            await self.db.execute(
                """
                UPDATE experiments
                SET metrics_summary = metrics_summary || $2::jsonb,
                    updated_at = NOW()
                WHERE id = $1
                """,
                uuid.UUID(experiment_id),
                metrics,
            )
        except Exception as e:
            logger.warning(f"Failed to update metrics summary: {e}")

    async def add_tags(self, experiment_id: str, tags: List[str]):
        """Append tags to an experiment (deduplicates)."""
        if not self.db.is_connected:
            return
        try:
            await self.db.execute(
                """
                UPDATE experiments
                SET tags = ARRAY(SELECT DISTINCT unnest(tags || $2::text[])),
                    updated_at = NOW()
                WHERE id = $1
                """,
                uuid.UUID(experiment_id),
                tags,
            )
        except Exception as e:
            logger.warning(f"Failed to add tags: {e}")

    async def get(self, experiment_id: str) -> Optional[ExperimentRun]:
        """Fetch a single experiment by ID."""
        if not self.db.is_connected:
            return None
        try:
            row = await self.db.fetchrow(
                "SELECT * FROM experiments WHERE id = $1",
                uuid.UUID(experiment_id),
            )
            if not row:
                return None
            return self._row_to_experiment(row)
        except Exception as e:
            logger.warning(f"Failed to fetch experiment {experiment_id}: {e}")
            return None

    async def list(
        self,
        status: Optional[str] = None,
        tags: Optional[List[str]] = None,
        search: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[ExperimentListItem]:
        """
        List experiments with optional filtering.

        - status: filter by status string
        - tags: filter experiments that have ALL specified tags
        - search: full-text search across name, script, tags
        - limit/offset: pagination
        """
        if not self.db.is_connected:
            return []

        conditions = []
        params: List[Any] = []
        idx = 1

        if status:
            conditions.append(f"status = ${idx}")
            params.append(status)
            idx += 1

        if tags:
            conditions.append(f"tags @> ${idx}::text[]")
            params.append(tags)
            idx += 1

        if search:
            conditions.append(f"search_vector @@ plainto_tsquery('english', ${idx})")
            params.append(search)
            idx += 1

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        params.extend([limit, offset])
        query = f"""
            SELECT
                id, name, script, status, progress, exit_code, tags,
                created_at, completed_at, started_at,
                (SELECT COUNT(*) FROM artifacts WHERE experiment_id = experiments.id) AS artifact_count
            FROM experiments
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
        """

        try:
            rows = await self.db.fetch(query, *params)
            result = []
            for row in rows:
                duration = None
                if row["started_at"] and row["completed_at"]:
                    duration = (row["completed_at"] - row["started_at"]).total_seconds()
                result.append(ExperimentListItem(
                    id=str(row["id"]),
                    name=row["name"],
                    script=row["script"],
                    status=row["status"],
                    progress=row["progress"],
                    exit_code=row["exit_code"],
                    tags=list(row["tags"] or []),
                    artifact_count=row["artifact_count"],
                    created_at=row["created_at"],
                    completed_at=row["completed_at"],
                    duration_seconds=duration,
                ))
            return result
        except Exception as e:
            logger.warning(f"Failed to list experiments: {e}")
            return []

    async def count(self, status: Optional[str] = None) -> int:
        """Count experiments, optionally filtered by status."""
        if not self.db.is_connected:
            return 0
        try:
            if status:
                return await self.db.fetchval(
                    "SELECT COUNT(*) FROM experiments WHERE status = $1", status
                ) or 0
            return await self.db.fetchval("SELECT COUNT(*) FROM experiments") or 0
        except Exception:
            return 0

    async def delete(self, experiment_id: str) -> bool:
        """Delete an experiment and all related records (cascades)."""
        if not self.db.is_connected:
            return False
        try:
            await self.db.execute(
                "DELETE FROM experiments WHERE id = $1",
                uuid.UUID(experiment_id),
            )
            return True
        except Exception as e:
            logger.warning(f"Failed to delete experiment {experiment_id}: {e}")
            return False

    async def cleanup_old(self, max_age_days: int = 90, keep_statuses: Optional[List[str]] = None) -> int:
        """
        Delete experiments older than max_age_days.
        If keep_statuses provided, only deletes experiments NOT in that list.
        Returns count of deleted experiments.
        """
        if not self.db.is_connected:
            return 0
        try:
            if keep_statuses:
                result = await self.db.fetchval(
                    """
                    WITH deleted AS (
                        DELETE FROM experiments
                        WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
                          AND status != ALL($2::text[])
                        RETURNING id
                    )
                    SELECT COUNT(*) FROM deleted
                    """,
                    str(max_age_days),
                    keep_statuses,
                )
            else:
                result = await self.db.fetchval(
                    """
                    WITH deleted AS (
                        DELETE FROM experiments
                        WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
                        RETURNING id
                    )
                    SELECT COUNT(*) FROM deleted
                    """,
                    str(max_age_days),
                )
            count = result or 0
            if count > 0:
                logger.info(f"Cleaned up {count} old experiments")
            return count
        except Exception as e:
            logger.warning(f"Cleanup failed: {e}")
            return 0

    # ---- Metrics --------------------------------------------------------

    async def record_metric(
        self,
        experiment_id: str,
        name: str,
        value: float,
        step: Optional[int] = None,
    ):
        """Insert a single metric observation."""
        if not self.db.is_connected:
            return
        try:
            await self.db.execute(
                """
                INSERT INTO metrics (experiment_id, name, value, step, recorded_at)
                VALUES ($1, $2, $3, $4, NOW())
                """,
                uuid.UUID(experiment_id), name, value, step,
            )
        except Exception as e:
            logger.warning(f"Failed to record metric: {e}")

    async def record_metrics_batch(
        self,
        experiment_id: str,
        metrics: Dict[str, float],
        step: Optional[int] = None,
    ):
        """Insert multiple metrics at once."""
        if not self.db.is_connected:
            return
        try:
            exp_uuid = uuid.UUID(experiment_id)
            rows = [
                (exp_uuid, name, value, step)
                for name, value in metrics.items()
                if isinstance(value, (int, float))
            ]
            if rows:
                await self.db.executemany(
                    """
                    INSERT INTO metrics (experiment_id, name, value, step, recorded_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    """,
                    rows,
                )
        except Exception as e:
            logger.warning(f"Failed to record metrics batch: {e}")

    async def get_metrics(
        self,
        experiment_id: str,
        name: Optional[str] = None,
        limit: int = 1000,
    ) -> Dict[str, List[Dict[str, Any]]]:
        """
        Retrieve metric history for an experiment.
        Returns: {metric_name: [{value, step, recorded_at}, ...]}
        """
        if not self.db.is_connected:
            return {}
        try:
            if name:
                rows = await self.db.fetch(
                    """
                    SELECT name, value, step, recorded_at
                    FROM metrics
                    WHERE experiment_id = $1 AND name = $2
                    ORDER BY recorded_at ASC
                    LIMIT $3
                    """,
                    uuid.UUID(experiment_id), name, limit,
                )
            else:
                rows = await self.db.fetch(
                    """
                    SELECT name, value, step, recorded_at
                    FROM metrics
                    WHERE experiment_id = $1
                    ORDER BY name, recorded_at ASC
                    LIMIT $2
                    """,
                    uuid.UUID(experiment_id), limit,
                )

            result: Dict[str, list] = {}
            for row in rows:
                metric_name = row["name"]
                if metric_name not in result:
                    result[metric_name] = []
                result[metric_name].append({
                    "value": row["value"],
                    "step": row["step"],
                    "recorded_at": row["recorded_at"].isoformat(),
                })
            return result
        except Exception as e:
            logger.warning(f"Failed to fetch metrics: {e}")
            return {}

    # ---- Checkpoints ----------------------------------------------------

    async def add_checkpoint(
        self,
        experiment_id: str,
        epoch: int,
        file_path: str,
        step: Optional[int] = None,
        file_size: Optional[int] = None,
        metrics: Optional[Dict[str, float]] = None,
    ) -> Optional[str]:
        """Register a model checkpoint."""
        if not self.db.is_connected:
            return None
        try:
            checkpoint_id = await self.db.fetchval(
                """
                INSERT INTO checkpoints (experiment_id, epoch, step, file_path, file_size, metrics)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id::text
                """,
                uuid.UUID(experiment_id), epoch, step, file_path,
                file_size, metrics or {},
            )
            return checkpoint_id
        except Exception as e:
            logger.warning(f"Failed to add checkpoint: {e}")
            return None

    async def get_checkpoints(self, experiment_id: str) -> List[Dict[str, Any]]:
        """List checkpoints for an experiment, ordered by epoch."""
        if not self.db.is_connected:
            return []
        try:
            rows = await self.db.fetch(
                """
                SELECT id::text, epoch, step, file_path, file_size, metrics, created_at
                FROM checkpoints
                WHERE experiment_id = $1
                ORDER BY epoch ASC
                """,
                uuid.UUID(experiment_id),
            )
            return [dict(row) for row in rows]
        except Exception as e:
            logger.warning(f"Failed to fetch checkpoints: {e}")
            return []

    # ---- Internal -------------------------------------------------------

    def _row_to_experiment(self, row) -> ExperimentRun:
        """Convert a database row to an ExperimentRun model."""
        config = ExperimentConfig(
            script=row["script"],
            args=list(row["args"] or []),
            cwd=row["cwd"],
            env_vars=dict(row["env_vars"] or {}),
        )
        return ExperimentRun(
            id=str(row["id"]),
            name=row["name"],
            config=config,
            status=row["status"],
            progress=row["progress"],
            exit_code=row["exit_code"],
            error=row["error"],
            tags=list(row["tags"] or []),
            metrics_summary=dict(row["metrics_summary"] or {}),
            stdout_preview=row["stdout_preview"] or "",
            stderr_preview=row["stderr_preview"] or "",
            stdout_path=row["stdout_path"],
            stderr_path=row["stderr_path"],
            relationships=[str(r) for r in (row["relationships"] or [])],
            created_at=row["created_at"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            updated_at=row["updated_at"],
        )
