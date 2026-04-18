import type { APIRoute } from 'astro';
import { query } from '../../../../../lib/db';

export const prerender = false;

/**
 * GET /api/jobs/:id/metrics/tags
 * Returns available metric tags for a job, with summary stats.
 */
export const GET: APIRoute = async ({ params }) => {
  const jobId = params.id!;

  try {
    const result = await query(
      `SELECT
         tag,
         COUNT(*) AS count,
         MIN(step)  AS min_step,
         MAX(step)  AS max_step,
         MIN(value) AS min_value,
         MAX(value) AS max_value,
         (array_agg(value ORDER BY step DESC))[1] AS last_value,
         (array_agg(value ORDER BY step ASC))[1]  AS first_value
       FROM job_metrics_scalars
       WHERE job_id = $1
       GROUP BY tag
       ORDER BY tag ASC`,
      [jobId]
    );

    return new Response(
      JSON.stringify({
        tags: result.rows.map(r => ({
          tag: r.tag,
          count: parseInt(r.count),
          min_step: r.min_step,
          max_step: r.max_step,
          min_value: parseFloat(r.min_value),
          max_value: parseFloat(r.max_value),
          last_value: parseFloat(r.last_value),
          first_value: parseFloat(r.first_value),
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
