/**
 * PostgreSQL database module for PyTorchRunner API
 * Handles connection pooling and schema initialization.
 */
import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let initialized = false;

function getPool(): pg.Pool {
  if (!pool) {
    const connStr = process.env.DATABASE_URL;
    if (!connStr) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    pool = new Pool({ connectionString: connStr });
  }
  return pool;
}

export async function initDb(): Promise<void> {
  if (initialized) return;
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id        TEXT PRIMARY KEY,
        namespace     TEXT NOT NULL DEFAULT 'default',
        script        TEXT NOT NULL DEFAULT '',
        args          JSONB NOT NULL DEFAULT '[]',
        cwd           TEXT NOT NULL DEFAULT '',
        env_vars      JSONB NOT NULL DEFAULT '{}',
        job_name      TEXT,
        tags          JSONB NOT NULL DEFAULT '[]',
        status        TEXT NOT NULL DEFAULT 'queued',
        progress      FLOAT NOT NULL DEFAULT 0,
        stdout_preview TEXT NOT NULL DEFAULT '',
        stderr_preview TEXT NOT NULL DEFAULT '',
        stdout_full   TEXT NOT NULL DEFAULT '',
        stderr_full   TEXT NOT NULL DEFAULT '',
        stdout_line_count INTEGER NOT NULL DEFAULT 0,
        stderr_line_count INTEGER NOT NULL DEFAULT 0,
        runner_id     TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        exit_code     INTEGER,
        error         TEXT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_namespace ON jobs(namespace)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS job_metrics (
        id          SERIAL PRIMARY KEY,
        job_id      TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        step        INTEGER,
        epoch       INTEGER,
        metrics     JSONB NOT NULL DEFAULT '{}',
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_metrics_job ON job_metrics(job_id)`);

    // Per-scalar metrics table for TensorBoard EventAccumulator pipeline
    await client.query(`
      CREATE TABLE IF NOT EXISTS job_metrics_scalars (
        id          SERIAL PRIMARY KEY,
        job_id      TEXT NOT NULL,
        tag         TEXT NOT NULL,
        step        INTEGER NOT NULL,
        value       DOUBLE PRECISION NOT NULL,
        wall_time   DOUBLE PRECISION NOT NULL DEFAULT 0,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (job_id, tag, step)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_metrics_scalars_job ON job_metrics_scalars(job_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_metrics_scalars_job_tag ON job_metrics_scalars(job_id, tag, step)`);

    // Media and artifacts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS job_media (
        id           SERIAL PRIMARY KEY,
        job_id       TEXT NOT NULL,
        filename     VARCHAR(512) NOT NULL,
        tag          VARCHAR(255),
        step         INTEGER,
        wall_time    DOUBLE PRECISION,
        media_type   VARCHAR(64)  NOT NULL DEFAULT 'image',
        content_type VARCHAR(128) NOT NULL DEFAULT 'image/png',
        file_size    INTEGER,
        width        INTEGER,
        height       INTEGER,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE(job_id, filename)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_job_media_job_id ON job_media(job_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_job_media_tag ON job_media(job_id, tag)`);

    initialized = true;
  } finally {
    client.release();
  }
}

export async function query<T = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
  await initDb();
  return getPool().query<T>(text, params);
}
