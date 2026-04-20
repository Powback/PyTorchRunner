/**
 * PyTorchRunner PowSync Schema
 *
 * Defines reactive tables for real-time job tracking, metrics, media, and runner state.
 * These mirror the PostgreSQL tables — the ServerStore is hydrated from PostgreSQL on
 * startup and kept in sync as API routes write to the DB.
 *
 * Table PKs:
 *   - jobs:               job_id (string UUID — primary, no auto-increment)
 *   - job_metrics_scalars: id (numeric serial from PostgreSQL)
 *   - job_media:          id (numeric serial from PostgreSQL)
 *   - runners:            id (string — in-memory only, no PostgreSQL table)
 */

import { table, field, reducer, Ok, Err } from 'powsync/schema';
import type { ReducerContext } from 'powsync/schema';

// ============================================================================
// Jobs table — mirrors PostgreSQL `jobs`
// ============================================================================

@table('jobs')
export class Job {
  @field({ primary: true }) job_id = '';          // string UUID — no auto-increment
  @field({ indexed: true }) namespace = 'default';
  @field() script = '';
  @field({ json: true }) args: string[] = [];
  @field() cwd = '';
  @field({ json: true }) env_vars: Record<string, string> = {};
  @field() job_name = '';
  @field({ json: true }) tags: string[] = [];
  @field({ indexed: true }) status = 'queued';   // queued | running | completed | failed | cancelled
  @field() progress = 0;
  @field() stdout_preview = '';
  @field() stderr_preview = '';
  @field() stdout_line_count = 0;
  @field() stderr_line_count = 0;
  @field({ indexed: true }) runner_id = '';
  @field() created_at = '';
  @field() updated_at = '';
  @field() started_at = '';
  @field() completed_at = '';
  @field() exit_code = 0;
  @field() error = '';

  /**
   * Sync a job row from the API (called after PostgreSQL writes).
   * Inserts the row if new, updates if existing.
   * Reducer name: "jobs.syncFromApi"
   */
  @reducer
  static syncFromApi(ctx: ReducerContext, job: Partial<Job> & { job_id: string }) {
    const table = ctx.db.jobs();
    const existing = table.id(job.job_id).find();
    if (existing) {
      table.id(job.job_id).update(job);
    } else {
      table.insert({ ...job });
    }
    return Ok(null);
  }
}

// ============================================================================
// Job metrics scalars — mirrors PostgreSQL `job_metrics_scalars`
// ============================================================================

@table('job_metrics_scalars')
export class JobMetricScalar {
  @field({ primary: true, autoInc: false }) id = 0;  // numeric serial from PostgreSQL
  @field({ indexed: true }) job_id = '';
  @field({ indexed: true }) tag = '';
  @field() step = 0;
  @field() value = 0;
  @field() wall_time = 0;

  /**
   * Upsert a batch of metric scalars (called after PostgreSQL writes).
   * Reducer name: "job_metrics_scalars.syncBatchFromApi"
   */
  @reducer
  static syncBatchFromApi(ctx: ReducerContext, jobId: string, points: Array<{
    id?: number; tag: string; step: number; value: number; wall_time: number;
  }>) {
    const table = ctx.db.job_metrics_scalars();
    for (const p of points) {
      if (p.id) {
        const existing = table.id(p.id).find();
        if (existing) {
          table.id(p.id).update({ value: p.value, wall_time: p.wall_time });
        } else {
          table.insert({ id: p.id, job_id: jobId, tag: p.tag, step: p.step, value: p.value, wall_time: p.wall_time });
        }
      } else {
        // No id from DB yet — insert with temp negative id (clients subscribe by job_id/tag)
        table.insert({ job_id: jobId, tag: p.tag, step: p.step, value: p.value, wall_time: p.wall_time });
      }
    }
    return Ok({ synced: points.length });
  }
}

// ============================================================================
// Job media — mirrors PostgreSQL `job_media`
// ============================================================================

@table('job_media')
export class JobMedia {
  @field({ primary: true, autoInc: false }) id = 0;
  @field({ indexed: true }) job_id = '';
  @field() filename = '';
  @field() tag = '';
  @field() step = 0;
  @field() wall_time = 0;
  @field() media_type = 'image';
  @field() content_type = 'image/png';
  @field() file_size = 0;
  @field() width = 0;
  @field() height = 0;
  @field() created_at = '';

  /** Sync a media record from the API. Reducer name: "job_media.syncFromApi" */
  @reducer
  static syncFromApi(ctx: ReducerContext, media: Partial<JobMedia> & { id: number; job_id: string }) {
    const table = ctx.db.job_media();
    const existing = table.id(media.id).find();
    if (existing) {
      table.id(media.id).update(media);
    } else {
      table.insert({ ...media });
    }
    return Ok(null);
  }
}

// ============================================================================
// Runners — in-memory only (no PostgreSQL table)
// ============================================================================

@table('runners')
export class Runner {
  @field({ primary: true }) id = '';              // string — no auto-increment
  @field() hostname = '';
  @field({ json: true }) capabilities: Record<string, any> = {};
  @field({ indexed: true }) namespace = 'default';
  @field() current_job = '';
  @field() registered_at = 0;
  @field() last_seen = 0;

  /** Upsert a runner heartbeat. Reducer name: "runners.upsert" */
  @reducer
  static upsert(ctx: ReducerContext, runner: Partial<Runner> & { id: string }) {
    const table = ctx.db.runners();
    const existing = table.id(runner.id).find();
    if (existing) {
      table.id(runner.id).update({ ...runner, last_seen: Date.now() });
    } else {
      table.insert({ ...runner, registered_at: Date.now(), last_seen: Date.now() });
    }
    return Ok(null);
  }

  /** Remove a stale runner. Reducer name: "runners.remove" */
  @reducer
  static remove(ctx: ReducerContext, id: string) {
    const existing = ctx.db.runners().id(id).find();
    if (!existing) return Err('Runner not found');
    ctx.db.runners().id(id).delete();
    return Ok(null);
  }
}
