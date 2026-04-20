/**
 * Helpers for notifying the PowSync ServerStore after PostgreSQL writes.
 *
 * These are fire-and-forget calls — PostgreSQL is the source of truth.
 * If PowSync isn't ready yet, calls are silently skipped and clients
 * will hydrate from PostgreSQL on their next subscription.
 */

import { getPowsync } from './globals';

/** Notify PowSync that a job row was created or updated. */
export function notifyJobChanged(job: Record<string, any>): void {
  const { router } = getPowsync();
  if (!router) return;
  router.executeFromHttp('/jobs/syncFromApi', 'POST', { job }, 'API_SYSTEM')
    .catch((err: Error) => console.warn('[powsync] notifyJobChanged failed:', err.message));
}

/** Notify PowSync that metric scalars were upserted. */
export function notifyMetricsChanged(
  jobId: string,
  points: Array<{ id?: number; tag: string; step: number; value: number; wall_time: number }>
): void {
  const { router } = getPowsync();
  if (!router) return;
  router.executeFromHttp(
    '/job_metrics_scalars/syncBatchFromApi',
    'POST',
    { jobId, points },
    'API_SYSTEM'
  ).catch((err: Error) => console.warn('[powsync] notifyMetricsChanged failed:', err.message));
}

/** Notify PowSync that a media record was created or updated. */
export function notifyMediaChanged(media: Record<string, any>): void {
  const { router } = getPowsync();
  if (!router) return;
  router.executeFromHttp('/job_media/syncFromApi', 'POST', { media }, 'API_SYSTEM')
    .catch((err: Error) => console.warn('[powsync] notifyMediaChanged failed:', err.message));
}

/** Notify PowSync that a runner registered or heartbeated. */
export function notifyRunnerChanged(runner: Record<string, any>): void {
  const { router } = getPowsync();
  if (!router) return;
  router.executeFromHttp('/runners/upsert', 'POST', { runner }, 'API_SYSTEM')
    .catch((err: Error) => console.warn('[powsync] notifyRunnerChanged failed:', err.message));
}
