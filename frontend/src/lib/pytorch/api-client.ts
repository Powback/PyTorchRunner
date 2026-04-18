/**
 * PyTorchRunner API Client
 * All calls go to same-origin /api/* — no CORS, no cross-origin issues.
 */

class PyTorchAPIClient {
  private base = '/api';

  // ── Jobs ──────────────────────────────────────────────────────────────────

  async submitJob(config: {
    script: string;
    args?: string[];
    cwd?: string;
    env_vars?: Record<string, string>;
    job_name?: string;
    namespace?: string;
    tags?: string[];
  }): Promise<{ job_id: string; status: string; namespace: string }> {
    const resp = await fetch(`${this.base}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || 'Job submission failed');
    }
    return resp.json();
  }

  async listJobs(params?: {
    status?: string;
    namespace?: string;
    limit?: number;
  }): Promise<any[]> {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    if (params?.namespace) q.set('namespace', params.namespace);
    if (params?.limit) q.set('limit', String(params.limit));
    const qs = q.toString() ? `?${q}` : '';
    const resp = await fetch(`${this.base}/jobs${qs}`);
    if (!resp.ok) throw new Error(`Failed to list jobs: ${resp.statusText}`);
    const data = await resp.json();
    return data.jobs ?? [];
  }

  async getJob(jobId: string): Promise<any> {
    const resp = await fetch(`${this.base}/jobs/${jobId}`);
    if (!resp.ok) throw new Error(`Job not found: ${jobId}`);
    return resp.json();
  }

  async cancelJob(jobId: string): Promise<void> {
    await fetch(`${this.base}/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
  }

  async getJobMetrics(jobId: string, tag?: string): Promise<{
    scalars: Record<string, Array<{ step: number; value: number; wall_time: number; recorded_at: string }>>;
    tags: string[];
  }> {
    const qs = tag ? `?tag=${encodeURIComponent(tag)}` : '';
    const resp = await fetch(`${this.base}/jobs/${jobId}/metrics${qs}`);
    if (!resp.ok) throw new Error(`Failed to get metrics: ${resp.statusText}`);
    return resp.json();
  }

  async getJobMetricsTags(jobId: string): Promise<Array<{
    tag: string; count: number; min_step: number; max_step: number;
    min_value: number; max_value: number; last_value: number; first_value: number;
  }>> {
    const resp = await fetch(`${this.base}/jobs/${jobId}/metrics/tags`);
    if (!resp.ok) throw new Error(`Failed to get metric tags: ${resp.statusText}`);
    const data = await resp.json();
    return data.tags ?? [];
  }

  async postJobMetrics(
    jobId: string,
    points: Array<{ tag: string; step: number; value: number; wall_time?: number }>
  ): Promise<{ inserted: number }> {
    const resp = await fetch(`${this.base}/jobs/${jobId}/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(points),
    });
    if (!resp.ok) throw new Error(`Failed to post metrics: ${resp.statusText}`);
    return resp.json();
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async getHealth(): Promise<any> {
    const resp = await fetch(`${this.base}/health`);
    if (!resp.ok) throw new Error(`Health check failed: ${resp.statusText}`);
    return resp.json();
  }

  // ── Runners ───────────────────────────────────────────────────────────────

  async listRunners(): Promise<any[]> {
    const resp = await fetch(`${this.base}/runners`);
    if (!resp.ok) throw new Error(`Failed to list runners: ${resp.statusText}`);
    const data = await resp.json();
    return data.runners ?? [];
  }

  // ── Legacy shims (keep old call sites working) ────────────────────────────

  /** @deprecated use submitJob */
  async submitScript(config: Parameters<PyTorchAPIClient['submitJob']>[0]) {
    return this.submitJob(config);
  }

  /** @deprecated use getJob */
  async getJobStatus(jobId: string) {
    return this.getJob(jobId);
  }

  /** @deprecated use getHealth */
  async getHealthStatus() {
    return this.getHealth();
  }

  /** @deprecated use listJobs */
  async listExperiments(params?: { status?: string; namespace?: string; limit?: number }) {
    return this.listJobs(params);
  }

  /** @deprecated use getJobMetrics */
  async getExperimentMetrics(jobId: string) {
    const metrics = await this.getJobMetrics(jobId);
    // Reshape to old {metricName: [{value, step, recorded_at}]} format
    const result: Record<string, Array<{ value: number; step?: number; recorded_at: string }>> = {};
    for (const point of metrics) {
      for (const [name, value] of Object.entries(point.metrics ?? {})) {
        if (!result[name]) result[name] = [];
        result[name].push({ value: value as number, step: point.step, recorded_at: point.recorded_at });
      }
    }
    return result;
  }

  // ── Media & Artifacts ────────────────────────────────────────────────────

  async listMedia(jobId: string, params?: {
    tag?: string;
    step_min?: number;
    step_max?: number;
  }): Promise<{ media: any[]; tags: string[]; total: number }> {
    const q = new URLSearchParams();
    if (params?.tag) q.set('tag', params.tag);
    if (params?.step_min != null) q.set('step_min', String(params.step_min));
    if (params?.step_max != null) q.set('step_max', String(params.step_max));
    const qs = q.toString() ? `?${q}` : '';
    const resp = await fetch(`${this.base}/jobs/${jobId}/media${qs}`);
    if (!resp.ok) throw new Error(`Failed to list media: ${resp.statusText}`);
    return resp.json();
  }

  async listArtifacts(jobId: string): Promise<any> {
    const resp = await fetch(`${this.base}/jobs/${jobId}/artifacts`);
    if (!resp.ok) throw new Error(`Failed to list artifacts: ${resp.statusText}`);
    return resp.json();
  }

  async uploadMedia(jobId: string, payload: {
    filename: string;
    tag?: string;
    step?: number;
    wall_time?: number;
    media_type?: string;
    content_type?: string;
    width?: number;
    height?: number;
    data: string; // base64
  }): Promise<any> {
    const resp = await fetch(`${this.base}/jobs/${jobId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || 'Media upload failed');
    }
    return resp.json();
  }

  // ── Experiment analysis (Tier 3) ──────────────────────────────────────────

  /** List all runs grouped by namespace. Returns {groups, totalRuns}. */
  async listExperimentGroups(): Promise<{ groups: any[]; totalRuns: number }> {
    const resp = await fetch(`${this.base}/experiments/groups`);
    if (!resp.ok) throw new Error(`Failed to list groups: ${resp.statusText}`);
    return resp.json();
  }

  /** Aggregated stats + all runs for one namespace group. */
  async getExperimentGroupSummary(group: string): Promise<any> {
    const resp = await fetch(`${this.base}/experiments/groups/${encodeURIComponent(group)}`);
    if (!resp.ok) throw new Error(`Failed to get group summary: ${resp.statusText}`);
    return resp.json();
  }

  /** List experiments with optional filters. */
  async listExperimentsFiltered(params?: {
    status?: string;
    tags?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    if (params?.tags)   q.set('tags', params.tags);
    if (params?.search) q.set('search', params.search);
    if (params?.limit)  q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    const qs = q.toString() ? `?${q}` : '';
    const resp = await fetch(`${this.base}/experiments${qs}`);
    if (!resp.ok) throw new Error(`Failed to list experiments: ${resp.statusText}`);
    const data = await resp.json();
    return Array.isArray(data) ? data : data.experiments ?? [];
  }

  // ── SSE streaming ─────────────────────────────────────────────────────

  createJobStream(jobId: string): EventSource {
    return new EventSource(`${this.base}/jobs/${jobId}/stream`);
  }

  parseSSEEvent(event: MessageEvent): any {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }

  // ── Formatting helpers ────────────────────────────────────────────────

  formatTimestamp(timestamp: number | string | null | undefined): string {
    if (!timestamp) return '—';
    const d = new Date(timestamp);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }

  calculateDuration(startTime: number | string, endTime: number | string = Date.now()): string {
    const s = new Date(startTime).getTime();
    const e = typeof endTime === 'string' ? new Date(endTime).getTime() : endTime;
    if (isNaN(s) || isNaN(e)) return '—';
    const d = e - s;
    const m = Math.floor(d / 60000);
    const sec = Math.floor((d % 60000) / 1000);
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }
}

export const pytorchAPI = new PyTorchAPIClient();
export default pytorchAPI;
