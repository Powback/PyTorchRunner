import type { APIRoute } from 'astro';
import { query } from '../../../lib/db';
export const prerender = false;

// GET /api/experiments/groups — list runs grouped by namespace
export const GET: APIRoute = async ({ url }) => {
  const result = await query(
    `SELECT
       namespace,
       COUNT(*)::int                                          AS total,
       COUNT(*) FILTER (WHERE status = 'queued')::int        AS queued,
       COUNT(*) FILTER (WHERE status = 'running')::int       AS running,
       COUNT(*) FILTER (WHERE status = 'completed')::int     AS completed,
       COUNT(*) FILTER (WHERE status = 'failed')::int        AS failed,
       MAX(created_at)                                        AS last_run
     FROM jobs
     GROUP BY namespace
     ORDER BY last_run DESC`
  );

  return new Response(JSON.stringify(result.rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
