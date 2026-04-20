/**
 * PyTorchRunner Experiment Dashboard
 * Real-time training metrics, live output, anomaly detection, and early-stopping recommendations.
 *
 * Uses PowSync reactive subscriptions (useQuery) for job status and metrics.
 * No SSE, no polling — data flows via WebSocket from the PowSync ServerStore.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

import { PowsyncProvider, useQuery, useConnection } from 'powsync/client';
import { getPowsyncClient } from '../../lib/powsync/client';
import { pytorchAPI } from '../../lib/pytorch/api-client';
import { ResourceMonitor } from './ResourceMonitor';
import type { MetricsChartData } from '../../types/pytorch';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnomalyAlert {
  id: string;
  type: 'nan_loss' | 'loss_spike' | 'loss_plateau' | 'accuracy_drop' | 'early_stop';
  message: string;
  severity: 'warning' | 'critical';
  timestamp: number;
}

interface ExperimentDashboardProps {
  experimentId?: number;
  jobId?: string;
  autoRefresh?: boolean;
}

// ── Anomaly detection ─────────────────────────────────────────────────────────

function detectAnomalies(
  loss: number[],
  accuracy: number[],
): Omit<AnomalyAlert, 'id'>[] {
  const alerts: Omit<AnomalyAlert, 'id'>[] = [];
  const now = Date.now();

  if (loss.some(v => isNaN(v) || !isFinite(v))) {
    alerts.push({ type: 'nan_loss', message: 'NaN or Inf detected in loss — training may have diverged.', severity: 'critical', timestamp: now });
  }

  if (loss.length >= 6) {
    const window = loss.slice(-6, -1);
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    const last = loss[loss.length - 1];
    if (last > avg * 2.5 && avg < 2) {
      alerts.push({ type: 'loss_spike', message: `Loss spike detected: ${last.toFixed(4)} vs avg ${avg.toFixed(4)}.`, severity: 'warning', timestamp: now });
    }
  }

  if (loss.length >= 20) {
    const window = loss.slice(-15);
    const first = window[0], last = window[window.length - 1];
    const relImprovement = Math.abs(first - last) / (Math.abs(first) + 1e-8);
    if (relImprovement < 0.001) {
      alerts.push({ type: 'loss_plateau', message: 'Loss has plateaued (<0.1% change in last 15 steps). Consider early stopping.', severity: 'warning', timestamp: now });
    }
  }

  if (accuracy.length >= 10) {
    const best = Math.max(...accuracy);
    const last = accuracy[accuracy.length - 1];
    if (best > 0.5 && (best - last) > 0.05) {
      alerts.push({ type: 'accuracy_drop', message: `Accuracy dropped ${((best - last) * 100).toFixed(1)}% from best (${(best * 100).toFixed(1)}%).`, severity: 'warning', timestamp: now });
    }
  }

  return alerts;
}

function shouldRecommendEarlyStopping(
  loss: number[],
  val_loss: number[],
): { recommend: boolean; reason: string } {
  if (loss.length < 20) return { recommend: false, reason: '' };

  const tail = loss.slice(-10);
  const head = loss.slice(-20, -10);
  if (tail.length && head.length) {
    const tailAvg = tail.reduce((a, b) => a + b) / tail.length;
    const headAvg = head.reduce((a, b) => a + b) / head.length;
    if (headAvg > 0 && Math.abs(headAvg - tailAvg) / headAvg < 0.005) {
      return { recommend: true, reason: 'Training loss has not improved in 10 steps (< 0.5% change).' };
    }
  }

  if (val_loss.length >= 10) {
    const recent = val_loss.slice(-5);
    const prev = val_loss.slice(-10, -5);
    const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
    const prevAvg = prev.reduce((a, b) => a + b) / prev.length;
    if (recentAvg > prevAvg * 1.05) {
      return { recommend: true, reason: 'Validation loss is increasing — possible overfitting. Consider stopping.' };
    }
  }

  return { recommend: false, reason: '' };
}

// ── Chart config ──────────────────────────────────────────────────────────────

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false as const,
  interaction: { intersect: false, mode: 'index' as const },
  scales: {
    x: { title: { display: true, text: 'Step' }, type: 'linear' as const },
    y: { title: { display: true, text: 'Value' }, beginAtZero: false },
  },
  plugins: {
    legend: { position: 'top' as const },
    tooltip: { filter: (item: any) => item.datasetIndex !== undefined },
  },
};

const METRIC_COLORS: Record<string, { border: string; bg: string }> = {
  loss:         { border: 'rgb(239, 68, 68)',   bg: 'rgba(239, 68, 68, 0.1)' },
  accuracy:     { border: 'rgb(34, 197, 94)',   bg: 'rgba(34, 197, 94, 0.1)' },
  learningRate: { border: 'rgb(168, 85, 247)',  bg: 'rgba(168, 85, 247, 0.1)' },
  val_loss:     { border: 'rgb(245, 158, 11)',  bg: 'rgba(245, 158, 11, 0.1)' },
  val_accuracy: { border: 'rgb(59, 130, 246)',  bg: 'rgba(59, 130, 246, 0.1)' },
  reward:       { border: 'rgb(20, 184, 166)',  bg: 'rgba(20, 184, 166, 0.1)' },
};

function alertId() {
  return Math.random().toString(36).slice(2, 9);
}

function parseTs(s: string | null | undefined): number {
  return s ? new Date(s).getTime() : 0;
}

// ── Inner component — uses PowSync hooks ──────────────────────────────────────

function ExperimentDashboardInner({ experimentId, jobId, autoRefresh = true }: ExperimentDashboardProps) {
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set(['loss']));
  const [anomalyAlerts, setAnomalyAlerts] = useState<AnomalyAlert[]>([]);
  const [earlyStop, setEarlyStop] = useState<{ recommend: boolean; reason: string }>({ recommend: false, reason: '' });
  const [autoScroll, setAutoScroll] = useState(true);
  const [showResourceMonitor, setShowResourceMonitor] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const outputRef = useRef<HTMLDivElement>(null);
  const seenAnomalyKeys = useRef<Set<string>>(new Set());

  // Reactive job status via PowSync
  const { data: jobRows } = useQuery({
    table: 'jobs',
    where: jobId ? { job_id: jobId } : undefined,
    subscribe: true,
  });

  // Reactive metrics via PowSync
  const { data: metricRows } = useQuery({
    table: 'job_metrics_scalars',
    where: jobId ? { job_id: jobId } : undefined,
    subscribe: true,
  });

  // WebSocket connection state
  const { isConnected } = useConnection();

  // Derive typed job fields from raw PowSync row
  const rawJob = (jobRows ?? [])[0] ?? null;
  const job = rawJob ? {
    jobId:        rawJob.job_id    as string,
    script:       rawJob.script    as string,
    status:       rawJob.status    as string,
    progress:     Number(rawJob.progress ?? 0),
    startedAt:    parseTs(rawJob.started_at   as string | undefined),
    completedAt:  parseTs(rawJob.completed_at  as string | undefined),
    stdoutPreview: (rawJob.stdout_preview as string | null) ?? '',
    stderrPreview: (rawJob.stderr_preview as string | null) ?? '',
  } : null;

  // Build metricsData: { steps: number[], [tag]: number[] }
  const metricsData = useMemo<Record<string, number[]>>(() => {
    const rows = metricRows ?? [];
    const byTag = new Map<string, Map<number, number>>();
    for (const row of rows) {
      const tag = row.tag as string;
      const step = Number(row.step);
      const value = Number(row.value);
      if (!byTag.has(tag)) byTag.set(tag, new Map());
      byTag.get(tag)!.set(step, value);
    }
    const allSteps = [...new Set(rows.map(r => Number(r.step)))].sort((a, b) => a - b);
    const result: Record<string, number[]> = { steps: allSteps };
    for (const [tag, stepMap] of byTag.entries()) {
      result[tag] = allSteps.map(s => stepMap.get(s) ?? NaN);
    }
    return result;
  }, [metricRows]);

  // Parse stdout/stderr preview as output lines for the terminal
  const outputLines = useMemo(() => {
    if (!job) return [] as Array<{ lineNo: number; line: string; stream: 'stdout' | 'stderr' }>;
    const lines: Array<{ lineNo: number; line: string; stream: 'stdout' | 'stderr' }> = [];
    let idx = 0;
    if (job.stdoutPreview) {
      for (const line of job.stdoutPreview.split('\n')) {
        lines.push({ lineNo: idx++, line, stream: 'stdout' });
      }
    }
    if (job.stderrPreview) {
      for (const line of job.stderrPreview.split('\n')) {
        lines.push({ lineNo: idx++, line, stream: 'stderr' });
      }
    }
    return lines;
  }, [job?.stdoutPreview, job?.stderrPreview]);

  // Auto-scroll output terminal
  useEffect(() => {
    if (autoScroll && outputRef.current) {
      outputRef.current.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [outputLines.length, autoScroll]);

  // Anomaly detection
  const loss     = (metricsData.loss     as number[] | undefined) ?? [];
  const accuracy = (metricsData.accuracy as number[] | undefined) ?? [];
  const val_loss = (metricsData.val_loss as number[] | undefined) ?? [];

  useEffect(() => {
    if (loss.length < 5) return;
    const newAnomalies = detectAnomalies(loss, accuracy);
    setAnomalyAlerts(prev => {
      const updated = [...prev];
      newAnomalies.forEach(a => {
        const key = `${a.type}:${Math.floor(a.timestamp / 30000)}`;
        if (!seenAnomalyKeys.current.has(key)) {
          seenAnomalyKeys.current.add(key);
          updated.push({ ...a, id: alertId() });
        }
      });
      return updated.slice(-10);
    });
    setEarlyStop(shouldRecommendEarlyStopping(loss, val_loss));
  }, [loss.length]);

  // Chart data
  const availableMetricKeys = useMemo(
    () => Object.keys(metricsData).filter(k => k !== 'steps' && Array.isArray(metricsData[k]) && metricsData[k].some(v => !isNaN(v))),
    [metricsData],
  );

  const chartData: MetricsChartData = useMemo(() => {
    const datasets: MetricsChartData['datasets'] = [];
    availableMetricKeys.forEach(key => {
      if (!selectedMetrics.has(key)) return;
      const data = metricsData[key];
      const color = METRIC_COLORS[key] ?? { border: 'rgb(107,114,128)', bg: 'rgba(107,114,128,0.1)' };
      datasets.push({
        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        data: metricsData.steps.map((step, i) => ({ x: step, y: data[i] })),
        borderColor: color.border,
        backgroundColor: color.bg,
        tension: 0.3,
      });
    });
    return { datasets };
  }, [metricsData, selectedMetrics, availableMetricKeys]);

  const toggleMetric = (m: string) => {
    setSelectedMetrics(prev => {
      const s = new Set(prev);
      s.has(m) ? s.delete(m) : s.add(m);
      return s;
    });
  };

  const handleCancelJob = async () => {
    if (!jobId) return;
    setCancelError(null);
    try {
      await pytorchAPI.cancelJob(jobId);
      // No need to setJob — PowSync will reactively update when the API writes to PostgreSQL
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Failed to cancel job');
    }
  };

  const dismissAnomaly = (id: string) => setAnomalyAlerts(prev => prev.filter(a => a.id !== id));

  const getStatusColor = (status: string) => {
    const map: Record<string, string> = {
      completed: 'text-green-600 bg-green-100',
      running: 'text-blue-600 bg-blue-100',
      failed: 'text-red-600 bg-red-100',
      cancelled: 'text-gray-600 bg-gray-100',
    };
    return map[status] ?? 'text-yellow-600 bg-yellow-100';
  };

  if (!jobId) {
    return <div className="text-center py-8 text-gray-500">No job selected for monitoring.</div>;
  }

  return (
    <div className="space-y-6">
      {/* Error banner */}
      {cancelError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-sm text-red-800">{cancelError}</p>
        </div>
      )}

      {/* Early-stopping recommendation */}
      {earlyStop.recommend && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 flex items-start gap-3">
          <span className="text-xl">🛑</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-800">Early Stopping Recommended</p>
            <p className="text-sm text-amber-700 mt-0.5">{earlyStop.reason}</p>
          </div>
          {job?.status === 'running' && (
            <button onClick={handleCancelJob} className="flex-shrink-0 inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700">
              Stop Job
            </button>
          )}
        </div>
      )}

      {/* Anomaly alerts */}
      {anomalyAlerts.length > 0 && (
        <div className="space-y-2">
          {anomalyAlerts.map(alert => (
            <div key={alert.id} className={`flex items-start justify-between gap-2 border rounded-md px-4 py-2 text-sm ${
              alert.severity === 'critical' ? 'bg-red-50 border-red-300 text-red-800' : 'bg-yellow-50 border-yellow-300 text-yellow-800'
            }`}>
              <div className="flex items-start gap-2">
                <span>{alert.severity === 'critical' ? '🔴' : '⚠️'}</span>
                <span>{alert.message}</span>
              </div>
              <button onClick={() => dismissAnomaly(alert.id)} className="flex-shrink-0 opacity-50 hover:opacity-100">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Job status header */}
      {job && (
        <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Job {job.jobId}</h2>
              <p className="text-sm text-gray-500">{job.script || experimentId || jobId?.slice(0, 12) || 'Unknown'}</p>
            </div>
            <div className="flex items-center space-x-3">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(job.status)}`}>
                {job.status}
              </span>
              <div
                className={`h-3 w-3 rounded-full ${isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}
                title={isConnected ? 'Live via PowSync' : 'Disconnected'}
              />
            </div>
          </div>

          {job.status === 'running' && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-gray-600">Progress</span>
                <span className="text-gray-900 font-medium">{Math.round(job.progress * 100)}%</span>
              </div>
              <div className="bg-gray-200 rounded-full h-2">
                <div className="bg-blue-600 h-2 rounded-full transition-all duration-300" style={{ width: `${job.progress * 100}%` }} />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex flex-wrap gap-4 text-sm text-gray-600">
              <span>Started: {job.startedAt ? pytorchAPI.formatTimestamp(job.startedAt) : '—'}</span>
              {job.completedAt > 0 && <span>Completed: {pytorchAPI.formatTimestamp(job.completedAt)}</span>}
              {job.startedAt > 0 && <span>Duration: {pytorchAPI.calculateDuration(job.startedAt, job.completedAt || Date.now())}</span>}
              {metricsData.steps.length > 0 && (
                <span className="text-indigo-600 font-medium">{metricsData.steps.length} metric points</span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowResourceMonitor(s => !s)}
                className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                {showResourceMonitor ? 'Hide' : 'Show'} System
              </button>
              {job.status === 'running' && (
                <button onClick={handleCancelJob} className="inline-flex items-center px-3 py-1.5 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50">
                  Cancel Job
                </button>
              )}
            </div>
          </div>

          {!isConnected && (
            <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-md p-3">
              <p className="text-sm text-yellow-800">PowSync disconnected — reconnecting…</p>
            </div>
          )}
        </div>
      )}

      {/* Resource monitor (toggleable) */}
      {showResourceMonitor && <ResourceMonitor />}

      {/* Training metrics chart */}
      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-lg font-medium text-gray-900">Training Metrics</h3>

          <div className="flex flex-wrap gap-2">
            {availableMetricKeys.map(key => {
              const data = metricsData[key];
              const color = METRIC_COLORS[key] ?? { border: 'rgb(107,114,128)', bg: '' };
              return (
                <button
                  key={key}
                  onClick={() => toggleMetric(key)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors border ${
                    selectedMetrics.has(key)
                      ? 'text-white border-transparent'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                  style={selectedMetrics.has(key) ? { backgroundColor: color.border, borderColor: color.border } : {}}
                >
                  {key.replace(/_/g, ' ')} ({data.filter(v => !isNaN(v)).length})
                </button>
              );
            })}
          </div>
        </div>

        {chartData.datasets.length > 0 ? (
          <div className="h-80">
            <Line data={chartData} options={chartOptions} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-80 text-gray-400">
            <div className="text-center">
              <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <p className="mt-2 text-sm">No metrics yet — waiting for job output…</p>
              <p className="mt-1 text-xs text-gray-300">
                Metrics are detected automatically from stdout or $PYTORCHRUNNER_METRICS
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Live output terminal */}
      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">Live Output</h3>
          <div className="flex items-center space-x-3">
            <label className="flex items-center text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={e => setAutoScroll(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 mr-2"
              />
              Auto-scroll
            </label>
            <span className="text-sm text-gray-500">{outputLines.length} lines</span>
          </div>
        </div>

        <div
          ref={outputRef}
          className="bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-xs h-80 overflow-y-auto leading-5"
        >
          {outputLines.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              Output will appear here when the job starts…
            </div>
          ) : (
            outputLines.map((line, idx) => (
              <div key={`${line.lineNo}-${idx}`} className={line.stream === 'stderr' ? 'text-red-400' : ''}>
                <span className="select-none text-gray-600 mr-3">{String(line.lineNo + 1).padStart(5, ' ')}</span>
                {line.line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Public export — self-contained with PowsyncProvider ──────────────────────

export function ExperimentDashboard(props: ExperimentDashboardProps) {
  const [client] = useState(() =>
    typeof window !== 'undefined' ? getPowsyncClient() : null
  );

  if (!client) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6 h-32" />
        <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6 h-80" />
        <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6 h-80" />
      </div>
    );
  }

  return (
    <PowsyncProvider client={client}>
      <ExperimentDashboardInner {...props} />
    </PowsyncProvider>
  );
}

export default ExperimentDashboard;
