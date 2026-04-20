import type { APIRoute } from 'astro';
import { query } from '../../lib/db';
import { listRunners } from '../../lib/runners';
export const prerender = false;

export const GET: APIRoute = async () => {
  const statusCounts = await query(
    `SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status`
  );

  const counts: Record<string, number> = {};
  for (const row of statusCounts.rows) {
    counts[row.status] = row.count;
  }

  const runners = listRunners();

  return new Response(
    JSON.stringify({
      status: 'ok',
      jobs: counts,
      runners: runners.length,
      runner_list: runners.map((r) => ({
        id: r.id,
        hostname: r.hostname,
        namespace: r.namespace,
        currentJob: r.currentJob,
        lastSeen: r.lastSeen,
      })),
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
