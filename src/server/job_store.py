"""
Persistent SQLite-backed job store for PyTorchRunner.

Stores job metadata across restarts so SpecLLM and other agents never lose
job history. Full stdout/stderr buffers remain in-memory only (too large to
persist efficiently); only preview fields are persisted.
"""
import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

import aiosqlite

logger = logging.getLogger(__name__)

DEFAULT_DB_PATH = os.path.join(
    os.path.expanduser("~"), ".pytorchrunner", "jobs.db"
)

# Fields that may be persisted / updated in the DB
_UPDATABLE_COLUMNS = frozenset({
    "status", "progress", "updated_at", "started_at",
    "completed_at", "exit_code", "stdout_preview", "stderr_preview", "error",
})

# Fields whose values are JSON-serialized lists/dicts in the DB
_JSON_COLUMNS = frozenset({"args", "env_vars"})


class JobStore:
    """Async SQLite job store with namespace-aware queries."""

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or os.environ.get(
            "PYTORCHRUNNER_DB_PATH", DEFAULT_DB_PATH
        )
        self._db: Optional[aiosqlite.Connection] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self):
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row
        await self._create_tables()
        logger.info("JobStore initialized: %s", self.db_path)

    async def close(self):
        if self._db:
            await self._db.close()
            self._db = None

    async def _create_tables(self):
        await self._db.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                job_id         TEXT PRIMARY KEY,
                namespace      TEXT NOT NULL DEFAULT 'default',
                script         TEXT NOT NULL,
                args           TEXT NOT NULL DEFAULT '[]',
                cwd            TEXT NOT NULL,
                job_name       TEXT,
                status         TEXT NOT NULL DEFAULT 'queued',
                progress       REAL NOT NULL DEFAULT 0.0,
                created_at     TEXT NOT NULL,
                updated_at     TEXT NOT NULL,
                started_at     TEXT,
                completed_at   TEXT,
                exit_code      INTEGER,
                stdout_preview TEXT DEFAULT '',
                stderr_preview TEXT DEFAULT '',
                error          TEXT
            )
        """)
        # Indices for the common filter patterns
        await self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_jobs_namespace"
            " ON jobs(namespace)"
        )
        await self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_jobs_status"
            " ON jobs(status)"
        )
        await self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_jobs_ns_status"
            " ON jobs(namespace, status)"
        )
        await self._db.execute(
            "CREATE INDEX IF NOT EXISTS idx_jobs_created"
            " ON jobs(created_at DESC)"
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Write operations
    # ------------------------------------------------------------------

    async def save_job(self, job_data: Dict[str, Any]):
        """Insert or replace a job record (called at creation time)."""
        await self._db.execute(
            """
            INSERT OR REPLACE INTO jobs
              (job_id, namespace, script, args, cwd, job_name,
               status, progress, created_at, updated_at,
               started_at, completed_at, exit_code,
               stdout_preview, stderr_preview, error)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                job_data["job_id"],
                job_data.get("namespace", "default"),
                job_data["script"],
                json.dumps(job_data.get("args", [])),
                job_data["cwd"],
                job_data.get("job_name"),
                job_data.get("status", "queued"),
                job_data.get("progress", 0.0),
                job_data["created_at"],
                job_data["updated_at"],
                job_data.get("started_at"),
                job_data.get("completed_at"),
                job_data.get("exit_code"),
                job_data.get("stdout_preview", ""),
                job_data.get("stderr_preview", ""),
                job_data.get("error"),
            ),
        )
        await self._db.commit()

    async def update_job(self, job_id: str, fields: Dict[str, Any]):
        """Update a subset of mutable columns for an existing job."""
        updates = {k: v for k, v in fields.items() if k in _UPDATABLE_COLUMNS}
        if not updates:
            return
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        await self._db.execute(
            f"UPDATE jobs SET {set_clause} WHERE job_id = ?",
            [*updates.values(), job_id],
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Read operations
    # ------------------------------------------------------------------

    async def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Fetch a single job by ID, or None if not found."""
        async with self._db.execute(
            "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
        ) as cur:
            row = await cur.fetchone()
            return self._deserialize(dict(row)) if row else None

    async def list_jobs(
        self,
        *,
        status: Optional[str] = None,
        namespace: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Return jobs matching optional filters, newest first."""
        conds: List[str] = []
        params: List[Any] = []
        if status:
            conds.append("status = ?")
            params.append(status)
        if namespace:
            conds.append("namespace = ?")
            params.append(namespace)
        where = ("WHERE " + " AND ".join(conds)) if conds else ""
        params.append(max(1, min(limit, 1000)))
        async with self._db.execute(
            f"SELECT * FROM jobs {where} ORDER BY created_at DESC LIMIT ?",
            params,
        ) as cur:
            rows = await cur.fetchall()
            return [self._deserialize(dict(r)) for r in rows]

    async def get_running_job_ids_by_namespace(self, namespace: str) -> List[str]:
        """Return job_ids of jobs that are running in the given namespace."""
        async with self._db.execute(
            "SELECT job_id FROM jobs WHERE namespace = ? AND status = 'running'",
            (namespace,),
        ) as cur:
            rows = await cur.fetchall()
            return [r["job_id"] for r in rows]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _deserialize(row: Dict[str, Any]) -> Dict[str, Any]:
        """Expand JSON-encoded columns back to Python objects."""
        for col in _JSON_COLUMNS:
            if col in row and isinstance(row[col], str):
                try:
                    row[col] = json.loads(row[col])
                except (json.JSONDecodeError, TypeError):
                    pass
        return row
