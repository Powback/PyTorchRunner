/**
 * GET /api/jobs  — list jobs with filtering
 * POST /api/jobs — submit a new job (goes to queue, picked up by a runner)
 */
import type { APIRoute } from 'astro';
import { query, initDb } from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  try {
    await initDb();
    const status = url.searchParams.get('status');
    const namespace = url.searchParams.get('namespace');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 1000);

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

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const result = await query(
      `SELECT job_id, namespace, script, args, cwd, env_vars, job_name, tags,
              status, progress, stdout_preview, stderr_preview,
              stdout_line_count, stderr_line_count, runner_id,
              created_at, updated_at, started_at, completed_at, exit_code, error
       FROM jobs ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    return new Response(JSON.stringify({ jobs: result.rows, total: result.rowCount }), {
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

export const POST: APIRoute = async ({ request }) => {
  try {
    await initDb();
    const body = await request.json();

    const {
      script = '',
      args = [],
      cwd = '',
      env_vars = {},
      job_name,
      namespace = 'default',
      tags = [],
    } = body;

    if (!script) {
      return new Response(JSON.stringify({ error: 'script is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const job_id = uuidv4();
    const now = new Date().toISOString();
    const name = job_name || `script-${job_id.slice(0, 8)}`;

    await query(
      `INSERT INTO jobs
        (job_id, namespace, script, args, cwd, env_vars, job_name, tags, status, progress, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',0,$9,$9)`,
      [job_id, namespace, script, JSON.stringify(args), cwd, JSON.stringify(env_vars), name, JSON.stringify(tags), now]
    );

    return new Response(JSON.stringify({ job_id, status: 'queued', namespace }), {
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
