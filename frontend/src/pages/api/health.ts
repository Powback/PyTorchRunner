/**
 * GET /api/health — system health including connected runners
 */
import type { APIRoute } from 'astro';
import { query } from '../../lib/db';
import { listRunners } from '../../lib/runners';

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    // DB connectivity + job counts
    const countResult = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued')   AS queued,
        COUNT(*) FILTER (WHERE status = 'running')  AS running,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')   AS failed
      FROM jobs
    `);

    const counts = countResult.rows[0];
    const runners = listRunners();

    return new Response(
      JSON.stringify({
        status: 'healthy',
        service: 'pytorch-runner-api',
        api_version: '4.0.0',
        db: 'connected',
        jobs: {
          queued: parseInt(counts.queued, 10),
          running: parseInt(counts.running, 10),
          completed: parseInt(counts.completed, 10),
          failed: parseInt(counts.failed, 10),
        },
        queue_size: parseInt(counts.queued, 10),
        active_jobs: parseInt(counts.running, 10),
        runners: {
          connected: runners.length,
          list: runners.map((r) => ({
            id: r.id,
            hostname: r.hostname,
            namespace: r.namespace,
            capabilities: r.capabilities,
            currentJob: r.currentJob,
            lastSeen: r.lastSeen,
          })),
        },
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        status: 'unhealthy',
        service: 'pytorch-runner-api',
        api_version: '4.0.0',
        error: err.message,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};
