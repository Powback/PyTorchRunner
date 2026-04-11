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
    start();
    return stop;
  }, [jobId, autoStart, start, stop]);

  return { ...state, start, stop };
}

export default useMetricsBridge;
