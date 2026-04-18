/**
 * POST /api/jobs/:id/media  — upload a media file (base64 JSON)
 * GET  /api/jobs/:id/media  — list media for a job
 */
import type { APIRoute } from 'astro';
import { query, initDb } from '../../../../../lib/db';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const prerender = false;

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '/artifacts';

function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._\-]/g, '_');
}

export const GET: APIRoute = async ({ params, url }) => {
  const jobId = params.id!;
  try {
    await initDb();
    const tag = url.searchParams.get('tag');
    const stepMin = url.searchParams.get('step_min');
    const stepMax = url.searchParams.get('step_max');

    let sql = `
      SELECT id, job_id, filename, tag, step, wall_time, media_type, content_type,
             file_size, width, height, created_at
      FROM job_media
      WHERE job_id = $1
    `;
    const params2: any[] = [jobId];
    let idx = 2;
    if (tag) { sql += ` AND tag = $${idx++}`; params2.push(tag); }
    if (stepMin) { sql += ` AND step >= $${idx++}`; params2.push(Number(stepMin)); }
    if (stepMax) { sql += ` AND step <= $${idx++}`; params2.push(Number(stepMax)); }
    sql += ` ORDER BY step ASC NULLS LAST, created_at ASC`;

    const result = await query(sql, params2);

    // Collect unique tags for filtering UI
    const tagsResult = await query(
      `SELECT DISTINCT tag FROM job_media WHERE job_id = $1 AND tag IS NOT NULL ORDER BY tag`,
      [jobId]
    );

    return new Response(JSON.stringify({
      media: result.rows.map(r => ({
        id: r.id,
        jobId: r.job_id,
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
      })),
      tags: tagsResult.rows.map(r => r.tag),
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

export const POST: APIRoute = async ({ params, request }) => {
  const jobId = params.id!;
  try {
    await initDb();
    const body = await request.json();

    const {
      filename: rawFilename,
      tag,
      step,
      wall_time,
      media_type = 'image',
      content_type = 'image/png',
      width,
      height,
      data, // base64-encoded file contents
    } = body;

    if (!rawFilename || !data) {
      return new Response(JSON.stringify({ error: 'filename and data are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const filename = sanitizeFilename(rawFilename);
    const jobDir = path.join(ARTIFACTS_DIR, jobId);
    if (!existsSync(jobDir)) {
      await mkdir(jobDir, { recursive: true });
    }

    const filePath = path.join(jobDir, filename);
    const buffer = Buffer.from(data, 'base64');
    await writeFile(filePath, buffer);

    // Upsert DB record
    const result = await query(
      `INSERT INTO job_media (job_id, filename, tag, step, wall_time, media_type, content_type, file_size, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_id, filename) DO UPDATE
         SET tag = EXCLUDED.tag,
             step = EXCLUDED.step,
             wall_time = EXCLUDED.wall_time,
             media_type = EXCLUDED.media_type,
             content_type = EXCLUDED.content_type,
             file_size = EXCLUDED.file_size,
             width = EXCLUDED.width,
             height = EXCLUDED.height
       RETURNING id, created_at`,
      [jobId, filename, tag ?? null, step ?? null, wall_time ?? null, media_type, content_type, buffer.length, width ?? null, height ?? null]
    );

    const row = result.rows[0];
    return new Response(JSON.stringify({
      id: row.id,
      jobId,
      filename,
      tag,
      step,
      mediaType: media_type,
      contentType: content_type,
      fileSize: buffer.length,
      url: `/api/jobs/${jobId}/media/${encodeURIComponent(filename)}`,
      createdAt: row.created_at,
    }), {
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
