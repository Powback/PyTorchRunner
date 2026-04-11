/**
 * PyTorchRunner Experiment Dashboard
 * Real-time training metrics, live output, anomaly detection, and early-stopping recommendations.
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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

import { pytorchAPI } from '../../lib/pytorch/api-client';
import { ResourceMonitor } from './ResourceMonitor';
import type { PyTorchJob, SSEJobEvent, MetricsChartData } from '../../types/pytorch';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnomalyAlert {
  id: string;
  type: 'nan_loss' | 'loss_spike' | 'loss_plateau' | 'accuracy_drop' | 'early_stop';
  message: string;
  severity: 'warning' | 'critical';
  timestamp: number;
}

interface MetricsData {
  loss: number[];
  accuracy?: number[];
  learningRate?: number[];
  val_loss?: number[];
  val_accuracy?: number[];
  timestamps: number[];
  steps: number[];
  [key: string]: number[] | undefined;
}

interface OutputLine {
  timestamp: number;
  line: string;
  stream: 'stdout' | 'stderr';
  lineNo: number;
}

interface ExperimentDashboardProps {
  experimentId?: number;
  jobId?: string;
  autoRefresh?: boolean;
}

// ── Anomaly detection ─────────────────────────────────────────────────────────

function detectAnomalies(metrics: MetricsData): Omit<AnomalyAlert, 'id'>[] {
  const alerts: Omit<AnomalyAlert, 'id'>[] = [];
  const now = Date.now();
  const { loss = [], accuracy = [] } = metrics;

  // NaN loss
  if (loss.some(v => isNaN(v) || !isFinite(v))) {
    alerts.push({ type: 'nan_loss', message: 'NaN or Inf detected in loss — training may have diverged.', severity: 'critical', timestamp: now });
  }

  // Loss spike: last value > 2× previous moving average (window=5)
  if (loss.length >= 6) {
    const window = loss.slice(-6, -1);
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    const last = loss[loss.length - 1];
    if (last > avg * 2.5 && avg < 2) {
      alerts.push({ type: 'loss_spike', message: `Loss spike detected: ${last.toFixed(4)} vs avg ${avg.toFixed(4)}.`, severity: 'warning', timestamp: now });
    }
  }

  // Loss plateau: last 10 steps have < 0.1% relative improvement
  if (loss.length >= 20) {
    const window = loss.slice(-15);
    const first = window[0], last = window[window.length - 1];
    const relImprovement = Math.abs(first - last) / (Math.abs(first) + 1e-8);
    if (relImprovement < 0.001) {
      alerts.push({ type: 'loss_plateau', message: `Loss has plateaued (<0.1% change in last 15 steps). Consider early stopping.`, severity: 'warning', timestamp: now });
    }
  }

  // Accuracy drop: last val_accuracy below best by > 5%
  if (accuracy && accuracy.length >= 10) {
    const best = Math.max(...accuracy);
    const last = accuracy[accuracy.length - 1];
    if (best > 0.5 && (best - last) > 0.05) {
      alerts.push({ type: 'accuracy_drop', message: `Accuracy dropped ${((best - last) * 100).toFixed(1)}% from best (${(best * 100).toFixed(1)}%).`, severity: 'warning', timestamp: now });
    }
  }

  return alerts;
}

function shouldRecommendEarlyStopping(metrics: MetricsData): { recommend: boolean; reason: string } {
  const { loss = [], val_loss } = metrics;

  if (loss.length < 20) return { recommend: false, reason: '' };

  // Plateau check
  const tail = loss.slice(-10);
  const head = loss.slice(-20, -10);
  if (tail.length && head.length) {
    const tailAvg = tail.reduce((a, b) => a + b) / tail.length;
    const headAvg = head.reduce((a, b) => a + b) / head.length;
    if (headAvg > 0 && Math.abs(headAvg - tailAvg) / headAvg < 0.005) {
      return { recommend: true, reason: 'Training loss has not improved in 10 steps (< 0.5% change).' };
    }
  }

  // Val loss divergence: val_loss consistently increasing while train loss decreases
  if (val_loss && val_loss.length >= 10) {
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

// ── Chart options ─────────────────────────────────────────────────────────────

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
};

function alertId() {
  return Math.random().toString(36).slice(2, 9);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ExperimentDashboard({ experimentId, jobId, autoRefresh = true }: ExperimentDashboardProps) {
  const [job, setJob] = useState<PyTorchJob | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsData>({ loss: [], accuracy: [], learningRate: [], val_loss: [], val_accuracy: [], timestamps: [], steps: [] });
  const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set(['loss']));
  const [anomalyAlerts, setAnomalyAlerts] = useState<AnomalyAlert[]>([]);
  const [earlyStop, setEarlyStop] = useState<{ recommend: boolean; reason: string }>({ recommend: false, reason: '' });
  const [autoScroll, setAutoScroll] = useState(true);
  const [showResourceMonitor, setShowResourceMonitor] = useState(false);

  const outputRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const seenAnomalyKeys = useRef<Set<string>>(new Set());

  // ── Load job + start SSE ───────────────────────────────────────────────────

  useEffect(() => {
    if (!jobId) return;
    let mounted = true;

    (async () => {
      try {
        const data = await pytorchAPI.getJobStatus(jobId);
        if (mounted) setJob(data);
        if (autoRefresh) startSSE();
      } catch (err) {
        if (mounted) setConnectionError(err instanceof Error ? err.message : 'Failed to load job');
      }
    })();

    return () => { mounted = false; stopSSE(); };
  }, [jobId, autoRefresh]);

  const startSSE = useCallback(() => {
    if (!jobId || sseRef.current) return;
    const es = pytorchAPI.createJobStream(jobId);
    sseRef.current = es;

    es.onopen = () => { setIsConnected(true); setConnectionError(null); };

    es.onmessage = (event) => {
      const data = pytorchAPI.parseSSEEvent(event);
      if (data) handleSSEEvent(data);
    };

    es.onerror = () => {
      setIsConnected(false);
      setConnectionError('Connection lost. Retrying…');
      setTimeout(() => {
        if (sseRef.current?.readyState === EventSource.CLOSED) {
          sseRef.current = null;
          startSSE();
        }
      }, 5000);
    };
  }, [jobId]);

  const stopSSE = () => {
    sseRef.current?.close();
    sseRef.current = null;
    setIsConnected(false);
  };

  // ── SSE event handler ──────────────────────────────────────────────────────

  const handleSSEEvent = (event: SSEJobEvent) => {
    switch (event.type) {
      case 'stdout':
      case 'stderr':
        if (event.line !== undefined && event.line_no !== undefined) {
          const line: OutputLine = { timestamp: Date.now(), line: event.line, stream: event.type, lineNo: event.line_no };
          setOutputLines(prev => [...prev, line].slice(-500));
          if (autoScroll && outputRef.current) {
            setTimeout(() => outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' }), 50);
          }
          const parsed = parseMetricsFromLine(event.line);
          if (parsed) applyMetricsUpdate(parsed);
        }
        break;

      case 'status':
        setJob(prev => prev ? { ...prev, status: event.status || prev.status, progress: event.progress ?? prev.progress } : prev);
        break;

      case 'metrics':
        if (event.metrics) applyMetricsUpdate({ metrics: event.metrics, step: event.step, epoch: event.epoch });
        break;

      case 'done':
        setIsConnected(false);
        setJob(prev => prev ? { ...prev, status: event.status || 'completed', progress: 1.0, exitCode: event.exit_code ?? 0 } : prev);
        stopSSE();
        break;
    }
  };

  // ── Metrics parsing & updating ─────────────────────────────────────────────

  const parseMetricsFromLine = (line: string): { metrics: Record<string, number>; step?: number; epoch?: number } | null => {
    const full = /Epoch (\d+)(?:\/\d+)?,?\s*Step (\d+),?\s*Loss:\s*([\d.]+)(?:,?\s*Acc(?:uracy)?:\s*([\d.]+))?/i.exec(line);
    if (full) {
      const m: Record<string, number> = { loss: parseFloat(full[3]) };
      if (full[4]) m.accuracy = parseFloat(full[4]);
      return { metrics: m, epoch: parseInt(full[1]), step: parseInt(full[2]) };
    }

    const lossOnly = /(?:^|\s)[Ll]oss[:\s=]+([\d.eE+\-]+)/.exec(line);
    if (lossOnly) {
      const m: Record<string, number> = { loss: parseFloat(lossOnly[1]) };
      const acc = /[Aa]cc(?:uracy)?[:\s=]+([\d.]+)/.exec(line);
      if (acc) m.accuracy = parseFloat(acc[1]);
      const valLoss = /[Vv]al[_\s][Ll]oss[:\s=]+([\d.eE+\-]+)/.exec(line);
      if (valLoss) m.val_loss = parseFloat(valLoss[1]);
      const valAcc = /[Vv]al[_\s][Aa]cc[:\s=]+([\d.]+)/.exec(line);
      if (valAcc) m.val_accuracy = parseFloat(valAcc[1]);
      const lr = /[Ll][Rr][:\s=]+([\d.eE+\-]+)/.exec(line);
      if (lr) m.learningRate = parseFloat(lr[1]);
      return { metrics: m };
    }

    return null;
  };

  const applyMetricsUpdate = (update: { metrics: Record<string, number>; step?: number; epoch?: number }) => {
    setMetricsData(prev => {
      const newStep = update.step ?? prev.steps.length;
      const updated: MetricsData = { ...prev };

      updated.steps = [...prev.steps, newStep];
      updated.timestamps = [...prev.timestamps, Date.now()];

      Object.entries(update.metrics).forEach(([k, v]) => {
        if (typeof v === 'number') {
          const existing = (updated[k] as number[] | undefined) ?? [];
          (updated as any)[k] = [...existing, v];
        }
      });

      // Cap at 1000 points
      if (updated.steps.length > 1000) {
        const trim = (arr: number[]) => arr.slice(-1000);
        Object.keys(updated).forEach(k => {
          if (Array.isArray((updated as any)[k])) (updated as any)[k] = trim((updated as any)[k]);
        });
      }

      return updated;
    });
  };

  // ── Anomaly detection effect (runs after each metrics update) ─────────────

  useEffect(() => {
    if (metricsData.loss.length < 5) return;

    const newAnomalies = detectAnomalies(metricsData);
    setAnomalyAlerts(prev => {
      const updated = [...prev];
      newAnomalies.forEach(a => {
        const key = `${a.type}:${Math.floor(a.timestamp / 30000)}`; // dedupe per 30s window
        if (!seenAnomalyKeys.current.has(key)) {
          seenAnomalyKeys.current.add(key);
          updated.push({ ...a, id: alertId() });
        }
      });
      return updated.slice(-10);
    });

    const es = shouldRecommendEarlyStopping(metricsData);
    setEarlyStop(es);
  }, [metricsData.loss.length]);

  // ── Chart data ─────────────────────────────────────────────────────────────

  const chartData: MetricsChartData = useMemo(() => {
    const datasets: MetricsChartData['datasets'] = [];
    const allMetricKeys = ['loss', 'accuracy', 'learningRate', 'val_loss', 'val_accuracy'];

    allMetricKeys.forEach(key => {
      const data = metricsData[key] as number[] | undefined;
      if (!selectedMetrics.has(key) || !data || data.length === 0) return;
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
  }, [metricsData, selectedMetrics]);

  const toggleMetric = (m: string) => {
    setSelectedMetrics(prev => {
      const s = new Set(prev);
      s.has(m) ? s.delete(m) : s.add(m);
      return s;
    });
  };

  const handleCancelJob = async () => {
    if (!jobId) return;
    try {
      await pytorchAPI.cancelJob(jobId);
      setJob(prev => prev ? { ...prev, status: 'cancelled' } : prev);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : 'Failed to cancel job');
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

  const allMetricKeys = ['loss', 'accuracy', 'learningRate', 'val_loss', 'val_accuracy'];

  if (!jobId) {
    return <div className="text-center py-8 text-gray-500">No job selected for monitoring.</div>;
  }

  return (
    <div className="space-y-6">
      {/* Error banner */}
      {connectionError && !job && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-sm text-red-800">{connectionError}</p>
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
              <p className="text-sm text-gray-500">Experiment {experimentId ?? 'Unknown'}</p>
            </div>
            <div className="flex items-center space-x-3">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(job.status)}`}>
                {job.status}
              </span>
              <div className={`h-3 w-3 rounded-full ${isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}
                   title={isConnected ? 'Live' : 'Disconnected'} />
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

          {connectionError && (
            <div className="mt-4 bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-sm text-red-800">{connectionError}</p>
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
            {allMetricKeys.map(key => {
              const data = metricsData[key] as number[] | undefined;
              const hasData = data && data.length > 0;
              const color = METRIC_COLORS[key] ?? { border: 'rgb(107,114,128)', bg: '' };
              return (
                <button
                  key={key}
                  onClick={() => hasData && toggleMetric(key)}
                  disabled={!hasData}
                  title={hasData ? undefined : 'No data yet'}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors border ${
                    selectedMetrics.has(key) && hasData
                      ? 'text-white border-transparent'
                      : hasData
                      ? 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                      : 'bg-gray-50 text-gray-300 border-gray-200 cursor-not-allowed'
                  }`}
                  style={selectedMetrics.has(key) && hasData ? { backgroundColor: color.border, borderColor: color.border } : {}}
                >
                  {key.replace(/_/g, ' ')}
                  {hasData && ` (${data!.length})`}
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

export default ExperimentDashboard;
