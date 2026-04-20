import type { APIRoute } from 'astro';
import { query } from '../../../lib/db';
export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const result = await query('SELECT * FROM jobs WHERE job_id = $1', [params.id]);

  if (result.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'Job not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(result.rows[0]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PATCH: APIRoute = async ({ params, request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 409 guard: if claiming the job (status=running), check it's still queued
  if (body.status === 'running') {
    const current = await query('SELECT status FROM jobs WHERE job_id = $1', [params.id]);
    if (current.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (current.rows[0].status === 'running') {
      return new Response(JSON.stringify({ error: 'Job already claimed by another runner' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Allowed updatable fields
  const ALLOWED = [
    'status', 'progress', 'runner_id',
    'stdout_preview', 'stdout_full', 'stdout_line_count',
    'stderr_preview', 'stderr_full', 'stderr_line_count',
    'started_at', 'completed_at', 'exit_code', 'error',
  ];

  const setClauses: string[] = [];
  const params_list: any[] = [];

  for (const field of ALLOWED) {
    if (field in body) {
      params_list.push(body[field]);
      setClauses.push(`${field} = $${params_list.length}`);
    }
  }

  if (setClauses.length === 0) {
    return new Response(JSON.stringify({ error: 'No updatable fields provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Always bump updated_at
  setClauses.push(`updated_at = NOW()`);

  params_list.push(params.id);
  const result = await query(
    `UPDATE jobs SET ${setClauses.join(', ')} WHERE job_id = $${params_list.length} RETURNING *`,
    params_list
  );

  if (result.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'Job not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(result.rows[0]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
