/**
 * useMetricsBridge — SSE-to-state Powsync bridge for real-time training metrics.
 *
 * Connects to the backend SSE stream for a job and maintains a local reactive
 * state store.  This is the "Powsync bridge" layer: the hook plays the role
 * that Powsync's local SQLite database would in a full Powsync setup — it
 * keeps the frontend in sync with the backend without polling.
 *
 * Architecture:
 *   Backend stdout / metrics.jsonl
 *     → _detect_metrics_in_line / _watch_metrics_file
 *     → SSE "metrics" events on /jobs/{id}/stream
 *     → useMetricsBridge (this hook)
 *     → React state (metricsData, outputLines, …)
 *     → Chart.js components re-render in real-time
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { pytorchAPI } from './api-client';
import type { SSEJobEvent } from '../../types/pytorch';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MetricsData {
  steps: number[];
  timestamps: number[];
  [metricName: string]: number[];
}

export interface OutputLine {
  timestamp: number;
  line: string;
  stream: 'stdout' | 'stderr';
  lineNo: number;
}

export interface MetricsBridgeState {
  metricsData: MetricsData;
  outputLines: OutputLine[];
  /** Current job status as reported by the SSE stream */
  status: string;
  progress: number;
  isConnected: boolean;
  connectionError: string | null;
  /** True once at least one explicit "metrics" SSE event has been received */
  hasExplicitMetrics: boolean;
}

// ── Metric parsing (frontend fallback) ───────────────────────────────────────

/**
 * Parse metrics from a stdout line.  Used as a fallback when the backend
 * has not yet emitted an explicit "metrics" SSE event for this line
 * (e.g. older backend versions or unrecognised patterns).
 */
function parseMetricsFromLine(
  line: string,
): { metrics: Record<string, number>; step?: number; epoch?: number } | null {
  const trimmed = line.trim();

  // Pure JSON object
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const data = JSON.parse(trimmed);
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'number') metrics[k] = v;
      }
      if (Object.keys(metrics).length > 0) {
        const step = typeof metrics.step === 'number' ? metrics.step : undefined;
        const epoch = typeof metrics.epoch === 'number' ? metrics.epoch : undefined;
        delete metrics.step;
        delete metrics.epoch;
        delete metrics.timestamp;
        return { metrics, step, epoch };
      }
    } catch { /* not valid JSON */ }
  }

  // Common text patterns: "loss=0.312 step=100" / "Loss: 0.312, Acc: 0.92"
  const lossMatch = /(?:^|\s)[Ll]oss\s*[=:]\s*([\d.eE+\-]+)/.exec(line);
  if (lossMatch) {
    const m: Record<string, number> = { loss: parseFloat(lossMatch[1]) };
    const acc = /[Aa]cc(?:uracy)?\s*[=:]\s*([\d.]+)/.exec(line);
    if (acc) m.accuracy = parseFloat(acc[1]);
    const valLoss = /[Vv]al[_\s][Ll]oss\s*[=:]\s*([\d.eE+\-]+)/.exec(line);
    if (valLoss) m.val_loss = parseFloat(valLoss[1]);
    const valAcc = /[Vv]al[_\s][Aa]cc\s*[=:]\s*([\d.]+)/.exec(line);
    if (valAcc) m.val_accuracy = parseFloat(valAcc[1]);
    const lr = /\b[Ll][Rr]\s*[=:]\s*([\d.eE+\-]+)/.exec(line);
    if (lr) m.learningRate = parseFloat(lr[1]);
    const reward = /[Rr]eward\s*[=:]\s*([\d.eE+\-]+)/.exec(line);
    if (reward) m.reward = parseFloat(reward[1]);
    const step = /\b[Ss]tep\s*[=:]\s*(\d+)/.exec(line);
    const epoch = /\b[Ee]poch\s*[=:]\s*(\d+)/.exec(line);
    return {
      metrics: m,
      step: step ? parseInt(step[1]) : undefined,
      epoch: epoch ? parseInt(epoch[1]) : undefined,
    };
  }

  return null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const MAX_OUTPUT_LINES = 500;
const MAX_METRIC_POINTS = 2000;

export function useMetricsBridge(
  jobId: string | undefined,
  autoStart = true,
): MetricsBridgeState & { start: () => void; stop: () => void } {
  const [state, setState] = useState<MetricsBridgeState>({
    metricsData: { steps: [], timestamps: [] },
    outputLines: [],
    status: 'queued',
    progress: 0,
    isConnected: false,
    connectionError: null,
    hasExplicitMetrics: false,
  });

  const sseRef = useRef<EventSource | null>(null);
  const hasExplicitMetricsRef = useRef(false);

  // ── Apply a metrics update to local state ─────────────────────────────

  const applyMetricsUpdate = useCallback(
    (update: { metrics: Record<string, number>; step?: number; epoch?: number }) => {
      setState(prev => {
        const newStep = update.step ?? prev.metricsData.steps.length;
        const updated: MetricsData = { ...prev.metricsData };

        updated.steps = [...prev.metricsData.steps, newStep];
        updated.timestamps = [...prev.metricsData.timestamps, Date.now()];

        for (const [k, v] of Object.entries(update.metrics)) {
          if (typeof v === 'number') {
            const existing = (updated[k] as number[] | undefined) ?? [];
            (updated as Record<string, number[]>)[k] = [...existing, v];
          }
        }

        // Cap series length to avoid unbounded growth
        if (updated.steps.length > MAX_METRIC_POINTS) {
          const trim = (arr: number[]) => arr.slice(-MAX_METRIC_POINTS);
          for (const k of Object.keys(updated)) {
            if (Array.isArray((updated as Record<string, unknown>)[k])) {
              (updated as Record<string, number[]>)[k] = trim(
                (updated as Record<string, number[]>)[k],
              );
            }
          }
        }

        return { ...prev, metricsData: updated };
      });
    },
    [],
  );

  // ── Start SSE connection ───────────────────────────────────────────────

  const start = useCallback(() => {
    if (!jobId || sseRef.current) return;

    const es = pytorchAPI.createJobStream(jobId);
    sseRef.current = es;

    es.onopen = () =>
      setState(p => ({ ...p, isConnected: true, connectionError: null }));

    es.onmessage = (event: MessageEvent) => {
      const data = pytorchAPI.parseSSEEvent(event) as SSEJobEvent | null;
      if (!data) return;

      switch (data.type) {
        case 'metrics':
          // Explicit structured metrics from the backend pipeline
          if (data.metrics) {
            hasExplicitMetricsRef.current = true;
            setState(p => ({ ...p, hasExplicitMetrics: true }));
            applyMetricsUpdate({
              metrics: data.metrics,
              step: data.step,
              epoch: data.epoch,
            });
          }
          break;

        case 'stdout':
        case 'stderr':
          if (data.line !== undefined && data.line_no !== undefined) {
            setState(p => ({
              ...p,
              outputLines: [
                ...p.outputLines,
                {
                  timestamp: Date.now(),
                  line: data.line!,
                  stream: data.type as 'stdout' | 'stderr',
                  lineNo: data.line_no!,
                },
              ].slice(-MAX_OUTPUT_LINES),
            }));
            // Fallback: parse metrics from stdout only when the backend hasn't
            // sent an explicit metrics event yet (avoids double-counting)
            if (!hasExplicitMetricsRef.current && data.type === 'stdout') {
              const parsed = parseMetricsFromLine(data.line!);
              if (parsed) applyMetricsUpdate(parsed);
            }
          }
          break;

        case 'status':
          setState(p => ({
            ...p,
            status: data.status || p.status,
            progress: data.progress ?? p.progress,
          }));
          break;

        case 'done':
          setState(p => ({
            ...p,
            isConnected: false,
            status: data.status || 'completed',
            progress: data.status === 'completed' ? 1.0 : p.progress,
          }));
          es.close();
          sseRef.current = null;
          break;
      }
    };

    es.onerror = () => {
      setState(p => ({
        ...p,
        isConnected: false,
        connectionError: 'Connection lost. Retrying…',
      }));
      // Auto-reconnect after 5 s
      setTimeout(() => {
        if (sseRef.current?.readyState === EventSource.CLOSED) {
          sseRef.current = null;
          start();
        }
      }, 5000);
    };
  }, [jobId, applyMetricsUpdate]);

  // ── Stop SSE connection ────────────────────────────────────────────────

  const stop = useCallback(() => {
    sseRef.current?.close();
    sseRef.current = null;
    setState(p => ({ ...p, isConnected: false }));
  }, []);

  // ── Lifecycle ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!jobId || !autoStart) return;
    hasExplicitMetricsRef.current = false;
    start();
    return stop;
  }, [jobId, autoStart, start, stop]);

  return { ...state, start, stop };
}

export default useMetricsBridge;
