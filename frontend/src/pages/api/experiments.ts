import type { APIRoute } from 'astro';
import { query } from '../../lib/db';
export const prerender = false;

// GET /api/experiments?status=&search=&tags=&limit=&offset=
export const GET: APIRoute = async ({ url }) => {
  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');
  const tags = url.searchParams.get('tags');
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const conditions: string[] = [];
  const params: any[] = [];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(job_name ILIKE $${params.length} OR script ILIKE $${params.length})`);
  }
  if (tags) {
    // tags is a comma-separated list
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length > 0) {
      params.push(JSON.stringify(tagList));
      conditions.push(`tags @> $${params.length}::jsonb`);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const result = await query(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return new Response(JSON.stringify(result.rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
