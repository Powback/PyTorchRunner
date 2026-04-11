"""
PostgreSQL Database Connection and Schema Management

Uses asyncpg for async connection pooling.
Schema is initialized on startup; migrations run automatically.
"""
import asyncpg
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# Schema version for migrations
SCHEMA_VERSION = 1

SCHEMA_SQL = """
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Core experiments table
CREATE TABLE IF NOT EXISTS experiments (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    script TEXT NOT NULL,
    args TEXT[] DEFAULT '{}',
    cwd TEXT NOT NULL,
    env_vars JSONB DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    progress FLOAT DEFAULT 0.0,
    exit_code INTEGER,
    error TEXT,
    stdout_preview TEXT DEFAULT '',
    stderr_preview TEXT DEFAULT '',
    stdout_path TEXT,
    stderr_path TEXT,
    tags TEXT[] DEFAULT '{}',
    relationships UUID[] DEFAULT '{}',
    metrics_summary JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full-text search vector (auto-updated on name/script/tags changes)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'experiments' AND column_name = 'search_vector'
    ) THEN
        ALTER TABLE experiments ADD COLUMN search_vector tsvector
            GENERATED ALWAYS AS (
                to_tsvector('english',
                    coalesce(name, '') || ' ' ||
                    coalesce(script, '') || ' ' ||
                    coalesce(array_to_string(tags, ' '), '')
                )
            ) STORED;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
CREATE INDEX IF NOT EXISTS idx_experiments_created_at ON experiments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_experiments_tags ON experiments USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_experiments_search ON experiments USING GIN(search_vector);

-- Time-series metrics (one row per named metric observation)
CREATE TABLE IF NOT EXISTS metrics (
    id BIGSERIAL PRIMARY KEY,
    experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    step INTEGER,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metrics_experiment_id ON metrics(experiment_id);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(experiment_id, name);
CREATE INDEX IF NOT EXISTS idx_metrics_recorded_at ON metrics(recorded_at DESC);

-- Artifacts table
CREATE TABLE IF NOT EXISTS artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT,
    metadata JSONB DEFAULT '{}',
    version INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_experiment_id ON artifacts(experiment_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);

-- Model checkpoints (specialized artifact)
CREATE TABLE IF NOT EXISTS checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    step INTEGER,
    file_path TEXT NOT NULL,
    file_size BIGINT,
    metrics JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_experiment_id ON checkpoints(experiment_id);
"""


class Database:
    """
    Async PostgreSQL connection pool with schema auto-initialization.

    Gracefully handles unavailability — callers check `is_connected`.
    """

    def __init__(self, dsn: Optional[str] = None):
        self.dsn = dsn or os.environ.get(
            "DATABASE_URL",
            "postgresql://pytorch:pytorch_secret@postgres:5432/pytorchrunner"
        )
        self._pool: Optional[asyncpg.Pool] = None

    @property
    def is_connected(self) -> bool:
        return self._pool is not None

    async def connect(self):
        """Initialize connection pool and ensure schema exists."""
        try:
            self._pool = await asyncpg.create_pool(
                self.dsn,
                min_size=2,
                max_size=10,
                command_timeout=30,
                # Allow time for PostgreSQL to start in Docker
                timeout=10,
            )
            await self._initialize_schema()
            logger.info("PostgreSQL connected and schema initialized")
        except Exception as e:
            logger.warning(f"PostgreSQL unavailable — storage disabled: {e}")
            self._pool = None

    async def disconnect(self):
        """Close all pool connections."""
        if self._pool:
            await self._pool.close()
            self._pool = None
            logger.info("PostgreSQL disconnected")

    async def _initialize_schema(self):
        """Run schema SQL and record migration version."""
        async with self._pool.acquire() as conn:
            await conn.execute(SCHEMA_SQL)
            # Record schema version
            await conn.execute(
                """
                INSERT INTO schema_migrations (version)
                VALUES ($1)
                ON CONFLICT (version) DO NOTHING
                """,
                SCHEMA_VERSION
            )

    async def acquire(self):
        """Context manager for acquiring a connection from the pool."""
        if not self._pool:
            raise RuntimeError("Database not connected")
        return self._pool.acquire()

    async def fetchrow(self, query: str, *args):
        """Execute a query and return a single row."""
        if not self._pool:
            return None
        async with self._pool.acquire() as conn:
            return await conn.fetchrow(query, *args)

    async def fetch(self, query: str, *args):
        """Execute a query and return all rows."""
        if not self._pool:
            return []
        async with self._pool.acquire() as conn:
            return await conn.fetch(query, *args)

    async def execute(self, query: str, *args):
        """Execute a query with no return value."""
        if not self._pool:
            return
        async with self._pool.acquire() as conn:
            await conn.execute(query, *args)

    async def executemany(self, query: str, args_list):
        """Execute a query with multiple argument sets."""
        if not self._pool:
            return
        async with self._pool.acquire() as conn:
            await conn.executemany(query, args_list)

    async def fetchval(self, query: str, *args):
        """Execute a query and return a single scalar value."""
        if not self._pool:
            return None
        async with self._pool.acquire() as conn:
            return await conn.fetchval(query, *args)
