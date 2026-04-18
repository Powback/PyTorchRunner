/**
 * GET /api/jobs/:id/artifacts — list all artifacts grouped by type
 */
import type { APIRoute } from 'astro';
import { query, initDb } from '../../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const jobId = params.id!;
  try {
    await initDb();

    const result = await query(
      `SELECT id, filename, tag, step, wall_time, media_type, content_type, file_size, width, height, created_at
       FROM job_media
       WHERE job_id = $1
       ORDER BY media_type, tag, step ASC NULLS LAST, created_at ASC`,
      [jobId]
    );

    // Group by media_type
    const groups: Record<string, any[]> = {};
    for (const r of result.rows) {
      const type = r.media_type || 'other';
      if (!groups[type]) groups[type] = [];
      groups[type].push({
        id: r.id,
        filename: r.filename,
        tag: r.tag,
        step: r.step,
        wallTime: r.wall_time,
        mediaType: r.media_type,
        contentType: r.content_type,
        fileSize: r.file_size,
        width: r.width,
        height: r.height,
        createdAt: r.created_at,
        url: `/api/jobs/${jobId}/media/${encodeURIComponent(r.filename)}`,
      });
    }

    const counts = Object.fromEntries(
      Object.entries(groups).map(([k, v]) => [k, v.length])
    );

    return new Response(JSON.stringify({
      jobId,
      artifacts: groups,
      counts,
      total: result.rows.length,
    }), {
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
