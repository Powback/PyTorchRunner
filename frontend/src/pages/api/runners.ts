import type { APIRoute } from 'astro';
import { listRunners, registerRunner } from '../../lib/runners';
import { notifyRunnerChanged } from '../../lib/powsync/dispatch';
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

  // Notify PowSync subscribers (fire-and-forget)
  notifyRunnerChanged({
    id: runner.id,
    hostname: runner.hostname,
    capabilities: runner.capabilities,
    namespace: runner.namespace,
    current_job: runner.currentJob || '',
    registered_at: runner.registeredAt,
    last_seen: runner.lastSeen,
  });

  return new Response(JSON.stringify(runner), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
