/**
 * GET /api/jobs/:id/media/:filename — serve a stored media file
 */
import type { APIRoute } from 'astro';
import { query, initDb } from '../../../../../lib/db';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const prerender = false;

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '/artifacts';

export const GET: APIRoute = async ({ params }) => {
  const jobId = params.id!;
  const filename = decodeURIComponent(params.filename!);

  try {
    await initDb();

    // Look up metadata from DB
    const result = await query(
      `SELECT content_type FROM job_media WHERE job_id = $1 AND filename = $2 LIMIT 1`,
      [jobId, filename]
    );

    if (result.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const contentType = result.rows[0].content_type || 'application/octet-stream';
    const filePath = path.join(ARTIFACTS_DIR, jobId, filename);

    if (!existsSync(filePath)) {
      return new Response(JSON.stringify({ error: 'File not found on disk' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await readFile(filePath);

    // Cache images aggressively; others less so
    const isImage = contentType.startsWith('image/');
    const cacheControl = isImage
      ? 'public, max-age=3600, stale-while-revalidate=86400'
      : 'public, max-age=300';

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Cache-Control': cacheControl,
        'Content-Disposition': `inline; filename="${filename}"`,
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  const jobId = params.id!;
  const filename = decodeURIComponent(params.filename!);

  try {
    await initDb();
    await query(
      `DELETE FROM job_media WHERE job_id = $1 AND filename = $2`,
      [jobId, filename]
    );
    return new Response(JSON.stringify({ ok: true }), {
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
