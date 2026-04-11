/**
 * GET  /api/jobs/:id  — job details + full output
 * PATCH /api/jobs/:id — update job (used by runners to report status/output)
 */
import type { APIRoute } from 'astro';
import { query } from '../../../lib/db';
import { heartbeatRunner } from '../../../lib/runners';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    const result = await query('SELECT * FROM jobs WHERE job_id = $1', [id]);
    if (result.rowCount === 0) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(result.rows[0]), {
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

export const PATCH: APIRoute = async ({ params, request }) => {
  try {
    const { id: job_id } = params;
    const body = await request.json();

    // Allowed fields runners can update
    const ALLOWED = [
      'status', 'progress', 'message', 'error',
      'stdout_preview', 'stderr_preview',
      'stdout_full', 'stderr_full',
      'stdout_line_count', 'stderr_line_count',
      'runner_id', 'exit_code',
    ] as const;

    type AllowedKey = typeof ALLOWED[number];

    const setClauses: string[] = [];
    const values: any[] = [];

    for (const key of ALLOWED) {
      if (key in body) {
        values.push(body[key as AllowedKey]);
        setClauses.push(`${key} = $${values.length}`);
      }
    }

    if (setClauses.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid fields to update' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Auto-set timestamps based on status transition
    const status = body.status as string | undefined;
    if (status === 'running') {
      setClauses.push('started_at = COALESCE(started_at, NOW())');
    } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      setClauses.push('completed_at = COALESCE(completed_at, NOW())');
    }
    setClauses.push('updated_at = NOW()');

    // If status=running, use atomic claim: only update if current status is 'queued'
    // This prevents two runners from grabbing the same job.
    let whereClause = 'WHERE job_id = $' + (values.length + 1);
    values.push(job_id);
    if (status === 'running') {
      whereClause += ` AND status = 'queued'`;
    }

    const result = await query(
      `UPDATE jobs SET ${setClauses.join(', ')} ${whereClause} RETURNING job_id, status`,
      values
    );

    if (result.rowCount === 0) {
      return new Response(JSON.stringify({ error: 'Job not found or already claimed' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Heartbeat runner if runner_id provided
    if (body.runner_id) {
      heartbeatRunner(body.runner_id, status === 'running' ? job_id : null);
    }

    return new Response(JSON.stringify(result.rows[0]), {
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
