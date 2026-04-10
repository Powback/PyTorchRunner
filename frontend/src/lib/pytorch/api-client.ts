/**
 * PyTorchRunner API Client
 * Handles communication with script execution and training APIs
 */

import type {
  PyTorchJob,
  PyTorchExperiment,
  HealthStatus,
  JobConfig,
  ApiResponse,
  SSEJobEvent
} from '../../types/pytorch';

class PyTorchAPIClient {
  private scriptApiUrl: string;
  private trainingApiUrl: string;

  constructor() {
    // Use external/browser-accessible URLs (pytorch-api.pow) for all client-side API calls.
    // PUBLIC_SCRIPT_API_URL is the Docker-internal URL (http://script-api:9100) — unusable from the browser.
    this.scriptApiUrl = import.meta.env.PUBLIC_EXTERNAL_SCRIPT_API || import.meta.env.PUBLIC_SCRIPT_API_URL || 'http://localhost:9100';
    this.trainingApiUrl = import.meta.env.PUBLIC_EXTERNAL_TRAINING_API || import.meta.env.PUBLIC_TRAINING_API_URL || 'http://localhost:8000';
  }

  // ============================================================================
  // SCRIPT EXECUTION API (Port 9100)
  // ============================================================================

  /**
   * Submit a script execution job
   */
  async submitScript(config: {
    script: string;
    args?: string[];
    cwd: string;
    env_vars?: Record<string, string>;
    job_name?: string;
  }): Promise<{ job_id: string; status: string }> {
    const response = await fetch(`${this.scriptApiUrl}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Script submission failed: ${error}`);
    }

    return response.json();
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<PyTorchJob> {
    const response = await fetch(`${this.scriptApiUrl}/jobs/${jobId}`);

    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.statusText}`);
    }

    const data = await response.json();

    // Transform API response to our interface
    return {
      id: Date.now(), // Will be managed by Powsync
      jobId: data.job_id,
      experimentId: 0, // Will be linked later
      type: 'script_execution',
      status: data.status,
      progress: data.progress,
      createdAt: new Date(data.created_at).getTime(),
      startedAt: data.started_at ? new Date(data.started_at).getTime() : 0,
      completedAt: data.completed_at ? new Date(data.completed_at).getTime() : 0,
      config: {
        type: 'script_execution',
        script: data.script,
        args: data.args,
        cwd: data.cwd,
        env_vars: data.env_vars,
      },
      metrics: {},
      error: data.error || '',
      exitCode: data.exit_code || 0,
      resourceUsage: '',
    };
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string): Promise<{ job_id: string; status: string }> {
    const response = await fetch(`${this.scriptApiUrl}/jobs/${jobId}/cancel`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`Failed to cancel job: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Cancel all jobs
   */
  async cancelAllJobs(): Promise<{ cancelled: number; job_ids: string[] }> {
    const response = await fetch(`${this.scriptApiUrl}/jobs/cancel_all`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`Failed to cancel jobs: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get health status
   */
  async getHealthStatus(): Promise<HealthStatus> {
    const response = await fetch(`${this.scriptApiUrl}/health`);

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Create SSE connection for job output streaming
   */
  createJobStream(jobId: string, sinceLine: number = 0): EventSource {
    const url = `${this.scriptApiUrl}/jobs/${jobId}/stream?since_line=${sinceLine}`;
    return new EventSource(url);
  }

  // ============================================================================
  // TRAINING API (Port 8000) - Future implementation
  // ============================================================================

  /**
   * Submit a training job
   */
  async submitTraining(config: {
    ml_model_config: Record<string, any>;
    training_params: Record<string, any>;
    data_config: Record<string, any>;
    project_path?: string;
    job_name?: string;
  }): Promise<{ job_id: string; status: string }> {
    const response = await fetch(`${this.trainingApiUrl}/train`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Training submission failed: ${error}`);
    }

    return response.json();
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Parse SSE event data
   */
  parseSSEEvent(event: MessageEvent): SSEJobEvent | null {
    try {
      return JSON.parse(event.data) as SSEJobEvent;
    } catch (error) {
      console.error('Failed to parse SSE event:', error);
      return null;
    }
  }

  /**
   * Format timestamps for display
   */
  formatTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  /**
   * Calculate duration between timestamps
   */
  calculateDuration(startTime: number, endTime: number = Date.now()): string {
    const duration = endTime - startTime;
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }
}

// Export singleton instance
export const pytorchAPI = new PyTorchAPIClient();
export default pytorchAPI;