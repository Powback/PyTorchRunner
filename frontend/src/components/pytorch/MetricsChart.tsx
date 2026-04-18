/**
 * MetricsChart — line chart for TensorBoard-style scalar metrics.
 *
 * Features:
 * - Auto-discovers metric tags from /api/jobs/:id/metrics/tags
 * - Toggle visibility per tag
 * - EMA smoothing slider (α ∈ [0, 1))
 * - X-axis toggle: step / wall time / relative time
 * - Download chart as PNG
 * - Auto-refresh polling while job is running
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
  Filler,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScalarPoint {
  step: number;
  value: number;
  wall_time: number;
  recorded_at: string;
}

interface TagInfo {
  tag: string;
  count: number;
  min_value: number;
  max_value: number;
  last_value: number;
  first_value: number;
}

interface MetricsChartProps {
  jobId: string;
  /** Poll for new data every N ms while job is running. 0 = no polling. */
  pollMs?: number;
  /** Height of the chart area in px */
  height?: number;
}

type XAxisMode = 'step' | 'wall_time' | 'relative';

// ── Colours ──────────────────────────────────────────────────────────────────

const PALETTE = [
  { border: 'rgb(239, 68, 68)',   bg: 'rgba(239, 68, 68, 0.08)' },
  { border: 'rgb(34, 197, 94)',   bg: 'rgba(34, 197, 94, 0.08)' },
  { border: 'rgb(59, 130, 246)',  bg: 'rgba(59, 130, 246, 0.08)' },
  { border: 'rgb(245, 158, 11)',  bg: 'rgba(245, 158, 11, 0.08)' },
  { border: 'rgb(168, 85, 247)',  bg: 'rgba(168, 85, 247, 0.08)' },
  { border: 'rgb(20, 184, 166)',  bg: 'rgba(20, 184, 166, 0.08)' },
  { border: 'rgb(249, 115, 22)',  bg: 'rgba(249, 115, 22, 0.08)' },
  { border: 'rgb(236, 72, 153)',  bg: 'rgba(236, 72, 153, 0.08)' },
];

function tagColor(index: number) {
  return PALETTE[index % PALETTE.length];
}

// ── EMA helper ────────────────────────────────────────────────────────────────

function ema(values: number[], alpha: number): number[] {
  if (alpha <= 0 || values.length === 0) return values;
  const out: number[] = [];
  let s = values[0];
  out.push(s);
  for (let i = 1; i < values.length; i++) {
    s = alpha * s + (1 - alpha) * values[i];
    out.push(s);
  }
  return out;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MetricsChart({ jobId, pollMs = 5000, height = 320 }: MetricsChartProps) {
  const chartRef = useRef<any>(null);

  const [tagInfos, setTagInfos] = useState<TagInfo[]>([]);
  const [scalars, setScalars] = useState<Record<string, ScalarPoint[]>>({});
  const [visibleTags, setVisibleTags] = useState<Set<string>>(new Set());
  const [smoothing, setSmoothing] = useState(0.6);
  const [xMode, setXMode] = useState<XAxisMode>('step');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch tags ─────────────────────────────────────────────────────────────

  const fetchTags = useCallback(async () => {
    try {
      const resp = await fetch(`/api/jobs/${jobId}/metrics/tags`);
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      const tags: TagInfo[] = data.tags ?? [];
      setTagInfos(tags);
      // Auto-select all new tags
      setVisibleTags(prev => {
        const next = new Set(prev);
        tags.forEach(t => next.add(t.tag));
        return next;
      });
    } catch (e: any) {
      setError(e.message);
    }
  }, [jobId]);

  // ── Fetch scalar data ──────────────────────────────────────────────────────

  const fetchScalars = useCallback(async () => {
    try {
      const resp = await fetch(`/api/jobs/${jobId}/metrics`);
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      setScalars(data.scalars ?? {});
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  // ── Initial load + optional polling ───────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      await fetchTags();
      await fetchScalars();
    }
    load();
    if (pollMs <= 0) return;
    const id = setInterval(() => {
      if (!cancelled) { fetchTags(); fetchScalars(); }
    }, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [fetchTags, fetchScalars, pollMs]);

  // ── Build Chart.js datasets ────────────────────────────────────────────────

  // Minimum wall_time across all data (for relative x-axis)
  const minWallTime = useMemo(() => {
    let min = Infinity;
    for (const pts of Object.values(scalars)) {
      for (const p of pts) if (p.wall_time < min) min = p.wall_time;
    }
    return isFinite(min) ? min : 0;
  }, [scalars]);

  const chartData = useMemo(() => {
    const datasets: any[] = [];
    tagInfos.forEach((info, idx) => {
      if (!visibleTags.has(info.tag)) return;
      const pts = scalars[info.tag] ?? [];
      if (pts.length === 0) return;

      const raw = pts.map(p => p.value);
      const smoothed = ema(raw, smoothing);
      const color = tagColor(idx);

      // x values
      const xVals = pts.map(p => {
        if (xMode === 'wall_time') return parseFloat(p.wall_time.toFixed(1));
        if (xMode === 'relative') return parseFloat(((p.wall_time - minWallTime) / 60).toFixed(2));
        return p.step;
      });

      datasets.push({
        label: info.tag,
        data: xVals.map((x, i) => ({ x, y: smoothed[i] })),
        borderColor: color.border,
        backgroundColor: color.bg,
        borderWidth: 1.5,
        pointRadius: pts.length > 200 ? 0 : 2,
        tension: 0.2,
        fill: false,
      });
    });
    return { datasets };
  }, [tagInfos, scalars, visibleTags, smoothing, xMode, minWallTime]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { intersect: false, mode: 'index' as const },
    scales: {
      x: {
        type: 'linear' as const,
        title: {
          display: true,
          text: xMode === 'step' ? 'Step' : xMode === 'wall_time' ? 'Wall Time (s)' : 'Elapsed (min)',
        },
      },
      y: {
        title: { display: true, text: 'Value' },
        beginAtZero: false,
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: (items: any[]) => {
            const x = items[0]?.parsed?.x;
            return xMode === 'step' ? `Step ${x}` : xMode === 'wall_time' ? `t=${x}s` : `+${x}min`;
          },
        },
      },
    },
  }), [xMode]);

  // ── Download as PNG ────────────────────────────────────────────────────────

  const downloadPng = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const url = chart.toBase64Image();
    const a = document.createElement('a');
    a.href = url;
    a.download = `metrics-${jobId.slice(0, 8)}.png`;
    a.click();
  };

  const toggleTag = (tag: string) => {
    setVisibleTags(prev => {
      const s = new Set(prev);
      s.has(tag) ? s.delete(tag) : s.add(tag);
      return s;
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
        Loading metrics…
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4 text-sm text-red-800">
        {error}
      </div>
    );
  }

  const hasData = tagInfos.length > 0;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {/* X-axis toggle */}
        <div className="flex items-center gap-1 border border-gray-200 rounded-md overflow-hidden text-xs">
          {(['step', 'wall_time', 'relative'] as XAxisMode[]).map(mode => (
            <button
              key={mode}
              onClick={() => setXMode(mode)}
              className={`px-2 py-1 ${xMode === mode ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              {mode === 'step' ? 'Step' : mode === 'wall_time' ? 'Time' : 'Elapsed'}
            </button>
          ))}
        </div>

        {/* Smoothing slider */}
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <span>Smooth</span>
          <input
            type="range"
            min="0"
            max="0.99"
            step="0.01"
            value={smoothing}
            onChange={e => setSmoothing(parseFloat(e.target.value))}
            className="w-20 accent-indigo-600"
          />
          <span className="w-8 text-right">{(smoothing * 100).toFixed(0)}%</span>
        </div>

        <div className="flex-1" />

        {/* Download */}
        <button
          onClick={downloadPng}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-gray-200 rounded-md text-gray-600 hover:bg-gray-50"
          title="Download chart as PNG"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          PNG
        </button>
      </div>

      {/* Tag toggle pills */}
      {tagInfos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tagInfos.map((info, idx) => {
            const color = tagColor(idx);
            const on = visibleTags.has(info.tag);
            return (
              <button
                key={info.tag}
                onClick={() => toggleTag(info.tag)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  on ? 'text-white border-transparent' : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'
                }`}
                style={on ? { backgroundColor: color.border, borderColor: color.border } : {}}
                title={`last: ${info.last_value?.toFixed(4)} · min: ${info.min_value?.toFixed(4)} · max: ${info.max_value?.toFixed(4)}`}
              >
                {info.tag}
                <span className={`${on ? 'text-white/70' : 'text-gray-400'}`}>({info.count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Chart */}
      {hasData ? (
        <div style={{ height }}>
          <Line ref={chartRef} data={chartData} options={chartOptions} />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center text-gray-400" style={{ height }}>
          <svg className="h-10 w-10 text-gray-200 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
          </svg>
          <p className="text-sm">No metric data yet</p>
          <p className="text-xs text-gray-300 mt-1">Use SummaryWriter or print metrics to stdout</p>
        </div>
      )}

      {/* Summary row */}
      {tagInfos.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {tagInfos.map(info => (
            <div key={info.tag} className="bg-gray-50 rounded-md px-3 py-2 text-xs">
              <div className="font-medium text-gray-700 truncate">{info.tag}</div>
              <div className="text-gray-500 mt-0.5">
                last <span className="text-gray-900 font-mono">{info.last_value?.toFixed(4)}</span>
              </div>
              <div className="text-gray-400">
                best {info.tag.includes('loss') || info.tag.includes('err')
                  ? <span className="font-mono">{info.min_value?.toFixed(4)}</span>
                  : <span className="font-mono">{info.max_value?.toFixed(4)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default MetricsChart;
