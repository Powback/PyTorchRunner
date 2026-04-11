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
    initialized = true;
  } finally {
    client.release();
  }
}

export async function query<T = any>(text: string, params?: any[]): Promise<pg.QueryResult<T>> {
  await initDb();
  return getPool().query<T>(text, params);
}
