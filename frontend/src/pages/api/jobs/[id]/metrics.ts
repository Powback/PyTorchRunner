/**
 * POST /api/jobs/:id/metrics — runner posts training metrics
 * GET  /api/jobs/:id/metrics — retrieve metrics for a job
 */
import type { APIRoute } from 'astro';
import { query } from '../../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ params, url }) => {
  try {
    const { id: job_id } = params;
    const limit = parseInt(url.searchParams.get('limit') || '1000', 10);

    const result = await query(
      `SELECT id, job_id, step, epoch, metrics, recorded_at
       FROM job_metrics
       WHERE job_id = $1
       ORDER BY recorded_at ASC
       LIMIT $2`,
      [job_id, limit]
    );

    return new Response(JSON.stringify({ metrics: result.rows }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  try {
    const { id: job_id } = params;
    const body = await request.json();

    // Support single metric point or array of points
    const points = Array.isArray(body) ? body : [body];

    for (const point of points) {
      const { step, epoch, metrics } = point;
      if (!metrics || typeof metrics !== 'object') continue;

      await query(
        `INSERT INTO job_metrics (job_id, step, epoch, metrics)
         VALUES ($1, $2, $3, $4)`,
        [job_id, step ?? null, epoch ?? null, JSON.stringify(metrics)]
      );
    }

    return new Response(JSON.stringify({ inserted: points.length }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
