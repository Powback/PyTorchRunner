import type { APIRoute } from 'astro';
import { query } from '../../../../lib/db';
export const prerender = false;

// GET /api/experiments/groups/:name — summary for one namespace group
export const GET: APIRoute = async ({ params }) => {
  const namespace = params.name;

  const [summary, recent] = await Promise.all([
    query(
      `SELECT
         namespace,
         COUNT(*)::int                                          AS total,
         COUNT(*) FILTER (WHERE status = 'queued')::int        AS queued,
         COUNT(*) FILTER (WHERE status = 'running')::int       AS running,
         COUNT(*) FILTER (WHERE status = 'completed')::int     AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')::int        AS failed,
         MAX(created_at)                                        AS last_run
       FROM jobs
       WHERE namespace = $1
       GROUP BY namespace`,
      [namespace]
    ),
    query(
      `SELECT * FROM jobs WHERE namespace = $1 ORDER BY created_at DESC LIMIT 20`,
      [namespace]
    ),
  ]);

  if (summary.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'Namespace not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({ ...summary.rows[0], jobs: recent.rows }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
