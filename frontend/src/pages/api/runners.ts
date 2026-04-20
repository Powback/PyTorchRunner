import type { APIRoute } from 'astro';
import { listRunners, registerRunner } from '../../lib/runners';
export const prerender = false;

export const GET: APIRoute = async () => {
  const runners = listRunners();
  return new Response(JSON.stringify(runners), {
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

  const { id, hostname, capabilities = {}, namespace = 'default', currentJob = null } = body;

  if (!id || !hostname) {
    return new Response(JSON.stringify({ error: 'id and hostname are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const runner = registerRunner(id, { hostname, capabilities, namespace, currentJob });

  return new Response(JSON.stringify(runner), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
