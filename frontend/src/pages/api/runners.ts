/**
 * GET  /api/runners — list connected runners
 * POST /api/runners — register a runner (called on runner startup)
 * DELETE /api/runners/:id handled by /api/runners/[id].ts
 */
import type { APIRoute } from 'astro';
import { registerRunner, listRunners } from '../../lib/runners';
import { v4 as uuidv4 } from 'uuid';

export const prerender = false;

export const GET: APIRoute = async () => {
  const runners = listRunners();
  return new Response(JSON.stringify({ runners, total: runners.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const id = body.id || uuidv4();
    const runner = registerRunner(id, {
      hostname: body.hostname || 'unknown',
      capabilities: body.capabilities || {},
      namespace: body.namespace || 'default',
      currentJob: null,
    });
    return new Response(JSON.stringify({ runner_id: runner.id, runner }), {
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
