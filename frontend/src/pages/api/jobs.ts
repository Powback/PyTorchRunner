import type { APIRoute } from 'astro';
import { query } from '../../lib/db';
export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const status = url.searchParams.get('status');
  const namespace = url.searchParams.get('namespace');
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);

  const conditions: string[] = [];
  const params: any[] = [];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (namespace) {
    params.push(namespace);
    conditions.push(`namespace = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const result = await query(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );

  return new Response(JSON.stringify(result.rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const {
    script,
    args = [],
    cwd = '',
    env_vars = {},
    job_name = null,
    tags = [],
    namespace = 'default',
  } = body;

  if (!script) {
    return new Response(JSON.stringify({ error: 'script is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const job_id = crypto.randomUUID();

  const result = await query(
    `INSERT INTO jobs (job_id, namespace, script, args, cwd, env_vars, job_name, tags, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')
     RETURNING *`,
    [job_id, namespace, script, JSON.stringify(args), cwd, JSON.stringify(env_vars), job_name, JSON.stringify(tags)]
  );

  return new Response(JSON.stringify(result.rows[0]), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};
