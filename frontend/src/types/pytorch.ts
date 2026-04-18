/**
 * PyTorchRunner TypeScript Type Definitions
 * For experiment tracking and job management
 */

export interface ExperimentConfig {
  description?: string;
  hyperparameters?: Record<string, any>;
  tags?: string[];
  modelType?: 'linear' | 'cnn' | 'transformer' | 'hybridlm';
  dataset?: string;
}

export interface JobConfig {
  type: 'training' | 'script_execution' | 'evaluation';
  script?: string;
  args?: string[];
  cwd?: string;
  env_vars?: Record<string, string>;
  model_config?: Record<string, any>;
  training_params?: Record<string, any>;
  data_config?: Record<string, any>;
}

export interface PyTorchExperiment {
  id: number;
  name: string;
  description: string;
  status: 'draft' | 'running' | 'completed' | 'failed' | 'cancelled';
  projectId: number;
  createdBy: string;
  createdAt: number;
  startedAt: number;
  completedAt: number;
  config: ExperimentConfig;
  hyperparameters: Record<string, any>;
  metrics: Record<string, number[]>; // time series
  finalMetrics: Record<string, number>;
  modelPath: string;
  checkpointPath: string;
  logPath: string;
  tags: string;
  notes: string;
  parentExperimentId: number;
}

export interface PyTorchJob {
  id: number;
  jobId: string; // UUID from Redis queue
  experimentId: number;
  type: 'training' | 'script_execution' | 'evaluation';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0.0 - 1.0
  createdAt: number;
  startedAt: number;
  completedAt: number;
  config: JobConfig;
  metrics: Record<string, any>;
  error: string;
  exitCode: number;
  resourceUsage: string;
}

export interface PyTorchMetricsStream {
  id: number;
  jobId: string;
  experimentId: number;
  timestamp: number;
  epoch: number;
  step: number;
  metrics: Record<string, number>;
  phase: 'train' | 'val' | 'test';
}

export interface PyTorchOutputStream {
  id: number;
  jobId: string;
  experimentId: number;
  timestamp: number;
  line: string;
  stream: 'stdout' | 'stderr';
  lineNo: number;
}

export interface HealthStatus {
  service: string;
  status: string;
  mpsAvailable: boolean;
  queueSize: number;
  activeJobs: number;
  apiVersion: string;
}

export interface SSEJobEvent {
  type: 'stdout' | 'stderr' | 'status' | 'metrics' | 'done';
  line?: string;
  line_no?: number;
  status?: string;
  exit_code?: number;
  stdout_lines?: number;
  stderr_lines?: number;
  job_id?: string;
  metrics?: Record<string, number>;
  epoch?: number;
  step?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Chart.js compatible data structure
export interface ChartDataPoint {
  x: number;
  y: number;
}

export interface MetricsChartData {
  datasets: {
    label: string;
    data: ChartDataPoint[];
    borderColor: string;
    backgroundColor?: string;
    tension?: number;
  }[];
}

export interface ResourceMonitoring {
  mpsMemoryUsed: number;
  mpsMemoryTotal: number;
  cpuUsage: number;
  queueSize: number;
  activeJobs: number;
  completedToday: number;
}

// ─── Media & Artifacts ───────────────────────────────────────────────────────

export type MediaType = 'image' | 'json' | 'checkpoint' | 'text' | 'other';

export interface JobMedia {
  id: number;
  jobId: string;
  filename: string;
  tag: string | null;
  step: number | null;
  wallTime: number | null;
  mediaType: MediaType;
  contentType: string;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  url: string;
}

export interface MediaListResponse {
  media: JobMedia[];
  tags: string[];
  total: number;
}

export interface ArtifactsResponse {
  jobId: string;
  artifacts: Record<MediaType, JobMedia[]>;
  counts: Record<MediaType, number>;
  total: number;
}

export interface MediaUploadRequest {
  filename: string;
  tag?: string;
  step?: number;
  wall_time?: number;
  media_type?: MediaType;
  content_type?: string;
  width?: number;
  height?: number;
  data: string; // base64-encoded
}