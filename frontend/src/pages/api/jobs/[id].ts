import type { APIRoute } from 'astro';
import { query } from '../../../lib/db';
import { notifyJobChanged } from '../../../lib/powsync/dispatch';
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

  const row = result.rows[0];

  // Notify PowSync subscribers (fire-and-forget — PostgreSQL is source of truth)
  notifyJobChanged({
    job_id: row.job_id,
    namespace: row.namespace,
    script: row.script,
    args: row.args,
    cwd: row.cwd,
    env_vars: row.env_vars,
    job_name: row.job_name,
    tags: row.tags,
    status: row.status,
    progress: parseFloat(row.progress) || 0,
    stdout_preview: row.stdout_preview,
    stderr_preview: row.stderr_preview,
    stdout_line_count: row.stdout_line_count || 0,
    stderr_line_count: row.stderr_line_count || 0,
    runner_id: row.runner_id || '',
    created_at: row.created_at ? new Date(row.created_at).toISOString() : '',
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : '',
    started_at: row.started_at ? new Date(row.started_at).toISOString() : '',
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : '',
    exit_code: row.exit_code || 0,
    error: row.error || '',
  });

  return new Response(JSON.stringify(row), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
