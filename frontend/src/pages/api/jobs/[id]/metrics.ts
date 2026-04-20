import type { APIRoute } from 'astro';
import { query } from '../../../../lib/db';
import { notifyMetricsChanged } from '../../../../lib/powsync/dispatch';

export const prerender = false;

/**
 * GET /api/jobs/:id/metrics[?tag=<tag>&limit=<n>]
 * Returns scalar metrics grouped by tag.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const jobId = params.id!;
  const tag = url.searchParams.get('tag');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '10000'), 50000);

  try {
    let result;
    if (tag) {
      result = await query(
        `SELECT tag, step, value, wall_time, recorded_at
         FROM job_metrics_scalars
         WHERE job_id = $1 AND tag = $2
         ORDER BY step ASC
         LIMIT $3`,
        [jobId, tag, limit]
      );
    } else {
      result = await query(
        `SELECT tag, step, value, wall_time, recorded_at
         FROM job_metrics_scalars
         WHERE job_id = $1
         ORDER BY tag ASC, step ASC
         LIMIT $2`,
        [jobId, limit]
      );
    }

    // Group rows by tag
    const scalars: Record<string, Array<{ step: number; value: number; wall_time: number; recorded_at: string }>> = {};
    for (const row of result.rows) {
      if (!scalars[row.tag]) scalars[row.tag] = [];
      scalars[row.tag].push({
        step: row.step,
        value: parseFloat(row.value),
        wall_time: parseFloat(row.wall_time),
        recorded_at: row.recorded_at,
      });
    }

    return new Response(
      JSON.stringify({ scalars, tags: Object.keys(scalars) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

/**
 * POST /api/jobs/:id/metrics
 * Accepts two formats:
 *   - New: [{tag, step, value, wall_time}, ...]
 *   - Legacy: [{step, metrics: {name: value}, wall_time?}, ...]
 */
export const POST: APIRoute = async ({ params, request }) => {
  const jobId = params.id!;

  try {
    const body = await request.json();
    if (!Array.isArray(body) || body.length === 0) {
      return new Response(
        JSON.stringify({ inserted: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Normalise to per-scalar points
    const points: Array<{ tag: string; step: number; value: number; wall_time: number }> = [];
    const nowSec = Date.now() / 1000;

    for (const item of body) {
      if ('tag' in item && 'value' in item) {
        // New scalar format
        points.push({
          tag: String(item.tag),
          step: Number(item.step) || 0,
          value: Number(item.value),
          wall_time: Number(item.wall_time) || nowSec,
        });
      } else if ('metrics' in item && item.metrics && typeof item.metrics === 'object') {
        // Legacy dict format: {step, metrics: {name: value}}
        const step = Number(item.step) || 0;
        const wallTime = Number(item.wall_time) || nowSec;
        for (const [name, val] of Object.entries(item.metrics as Record<string, unknown>)) {
          const num = Number(val);
          if (!isNaN(num)) {
            points.push({ tag: name, step, value: num, wall_time: wallTime });
          }
        }
      }
    }

    if (points.length === 0) {
      return new Response(
        JSON.stringify({ inserted: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Batch upsert — idempotent on (job_id, tag, step)
    const placeholders: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const p of points) {
      placeholders.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4})`);
      values.push(jobId, p.tag, p.step, p.value, p.wall_time);
      i += 5;
    }

    await query(
      `INSERT INTO job_metrics_scalars (job_id, tag, step, value, wall_time)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (job_id, tag, step) DO UPDATE
         SET value = EXCLUDED.value,
             wall_time = EXCLUDED.wall_time`,
      values
    );

    // Notify PowSync subscribers (fire-and-forget)
    notifyMetricsChanged(jobId, points);

    return new Response(
      JSON.stringify({ inserted: points.length }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
