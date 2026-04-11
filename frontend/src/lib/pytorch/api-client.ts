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

  async getJobMetrics(jobId: string): Promise<any[]> {
    const resp = await fetch(`${this.base}/jobs/${jobId}/metrics`);
    if (!resp.ok) throw new Error(`Failed to get metrics: ${resp.statusText}`);
    const data = await resp.json();
    return data.metrics ?? [];
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

  formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  calculateDuration(startTime: number, endTime: number = Date.now()): string {
    const d = endTime - startTime;
    const m = Math.floor(d / 60000);
    const s = Math.floor((d % 60000) / 1000);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
}

export const pytorchAPI = new PyTorchAPIClient();
export default pytorchAPI;
