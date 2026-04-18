/**
 * HistogramViewer
 * Shows the distribution of a metric's final values across all runs as a histogram.
 * Select metric → bar chart of binned value counts.
 * Also shows basic stats: mean, std, min, max.
 */

import React, { useState, useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

export interface HistogramRun {
  jobId: string;
  name: string;
  finalMetrics: Record<string, number>;
  status: string;
}

interface HistogramViewerProps {
  runs: HistogramRun[];
  defaultBins?: number;
}

function computeStats(vals: number[]) {
  if (vals.length === 0) return null;
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...vals),
    max: Math.max(...vals),
    median: [...vals].sort((a, b) => a - b)[Math.floor(n / 2)],
    count: n,
  };
}

function buildHistogram(vals: number[], bins: number) {
  if (vals.length === 0) return { labels: [], counts: [] };
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const range = mx - mn || 1;
  const width = range / bins;
  const counts = new Array(bins).fill(0);
  for (const v of vals) {
    const idx = Math.min(Math.floor((v - mn) / width), bins - 1);
    counts[idx]++;
  }
  const labels = counts.map((_, i) => {
    const lo = mn + i * width;
    const hi = lo + width;
    return `${formatLabel(lo)}–${formatLabel(hi)}`;
  });
  return { labels, counts };
}

function formatLabel(v: number): string {
  if (Math.abs(v) < 0.001 && v !== 0) return v.toExponential(1);
  if (Math.abs(v) >= 10000) return v.toExponential(1);
  return parseFloat(v.toPrecision(3)).toString();
}

export function HistogramViewer({ runs, defaultBins = 10 }: HistogramViewerProps) {
  const [selectedMetric, setSelectedMetric] = useState('');
  const [bins, setBins] = useState(defaultBins);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const metrics = useMemo(() => {
    const s = new Set<string>();
    runs.forEach(r => Object.keys(r.finalMetrics).forEach(k => s.add(k)));
    return [...s];
  }, [runs]);

  const activeMetric = selectedMetric || metrics[0] || '';

  const filteredRuns = useMemo(() =>
    filterStatus === 'all' ? runs : runs.filter(r => r.status === filterStatus),
    [runs, filterStatus]
  );

  const values = useMemo(() =>
    filteredRuns
      .map(r => r.finalMetrics[activeMetric])
      .filter((v): v is number => v !== undefined),
    [filteredRuns, activeMetric]
  );

  const stats = useMemo(() => computeStats(values), [values]);
  const { labels, counts } = useMemo(() => buildHistogram(values, bins), [values, bins]);

  const chartData = {
    labels,
    datasets: [{
      label: activeMetric,
      data: counts,
      backgroundColor: 'rgba(99, 102, 241, 0.65)',
      borderColor: 'rgba(99, 102, 241, 0.9)',
      borderWidth: 1,
      borderRadius: 3,
    }],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    plugins: {
      legend: { display: false },
      title: { display: false },
      tooltip: {
        callbacks: {
          title: (items: any[]) => labels[items[0]?.dataIndex] || '',
          label: (item: any) => `${item.raw} run${item.raw !== 1 ? 's' : ''}`,
        },
      },
    },
    scales: {
      x: {
        title: { display: true, text: activeMetric, font: { size: 11 } },
        ticks: { maxRotation: 45, font: { size: 10 } },
      },
      y: {
        title: { display: true, text: 'Count', font: { size: 11 } },
        beginAtZero: true,
        ticks: { precision: 0 },
      },
    },
  };

  const statuses = useMemo(() => {
    const s = new Set(runs.map(r => r.status));
    return ['all', ...s];
  }, [runs]);

  if (runs.length === 0) {
    return <div className="text-center py-12 text-gray-400 text-sm">No runs to show distributions for.</div>;
  }

  if (metrics.length === 0) {
    return <div className="text-center py-12 text-gray-400 text-sm">No metric data found across runs.</div>;
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-700">Metric</label>
          <select
            value={activeMetric}
            onChange={e => setSelectedMetric(e.target.value)}
            className="rounded-md border border-gray-300 text-sm px-2 py-1.5 focus:border-indigo-500 focus:outline-none"
          >
            {metrics.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-700">Status</label>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="rounded-md border border-gray-300 text-sm px-2 py-1.5 focus:border-indigo-500 focus:outline-none"
          >
            {statuses.map(s => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-700">Bins</label>
          <input
            type="range"
            min={3}
            max={20}
            value={bins}
            onChange={e => setBins(Number(e.target.value))}
            className="w-20 accent-indigo-600"
          />
          <span className="text-sm text-gray-500 w-4">{bins}</span>
        </div>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Count', value: stats.count, fmt: (v: number) => String(v) },
            { label: 'Mean',   value: stats.mean,   fmt: formatLabel },
            { label: 'Std',    value: stats.std,    fmt: formatLabel },
            { label: 'Min',    value: stats.min,    fmt: formatLabel },
            { label: 'Max',    value: stats.max,    fmt: formatLabel },
          ].map(({ label, value, fmt }) => (
            <div key={label} className="bg-gray-50 rounded-lg px-3 py-2 text-center">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="text-sm font-semibold text-gray-900 font-mono">{fmt(value)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      {values.length > 0 ? (
        <div className="h-64">
          <Bar data={chartData} options={chartOptions} />
        </div>
      ) : (
        <div className="text-center py-8 text-gray-400 text-sm">
          No values for <strong>{activeMetric}</strong> with current filters.
        </div>
      )}
    </div>
  );
}

export default HistogramViewer;
