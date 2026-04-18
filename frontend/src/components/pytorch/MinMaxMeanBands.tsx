/**
 * MinMaxMeanBands
 * Multi-run chart with shaded confidence bands.
 * When multiple runs share the same metric, shows:
 *   - Mean line (solid)
 *   - Min/max shaded area (or ±std area)
 * Useful for showing variance across seeds / hyperparameter sweeps.
 */

import React, { useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

export interface BandRun {
  jobId: string;
  name: string;
  metricSeries: Record<string, number[]>; // metric → time-series values
}

interface MinMaxMeanBandsProps {
  runs: BandRun[];
  defaultMetric?: string;
}

type BandMode = 'minmax' | 'std';

const BAND_COLOR = 'rgba(99, 102, 241, 0.15)';
const MEAN_COLOR = 'rgba(99, 102, 241, 0.9)';

function buildBandDatasets(series: number[][], mode: BandMode) {
  if (series.length === 0) return { labels: [], datasets: [] };

  // Align all series to the shortest length
  const len = Math.min(...series.map(s => s.length));
  if (len === 0) return { labels: [], datasets: [] };

  const aligned = series.map(s => s.slice(0, len));
  const labels = Array.from({ length: len }, (_, i) => String(i + 1));

  const means = Array.from({ length: len }, (_, i) => {
    const vals = aligned.map(s => s[i]);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  });

  let lowers: number[];
  let uppers: number[];

  if (mode === 'minmax') {
    lowers = Array.from({ length: len }, (_, i) => Math.min(...aligned.map(s => s[i])));
    uppers = Array.from({ length: len }, (_, i) => Math.max(...aligned.map(s => s[i])));
  } else {
    // ±1 std
    const stds = Array.from({ length: len }, (_, i) => {
      const vals = aligned.map(s => s[i]);
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / (vals.length > 1 ? vals.length - 1 : 1);
      return Math.sqrt(v);
    });
    lowers = means.map((m, i) => m - stds[i]);
    uppers = means.map((m, i) => m + stds[i]);
  }

  const datasets = [
    // Upper band boundary (filled to lower)
    {
      label: mode === 'minmax' ? 'Max' : '+1σ',
      data: uppers,
      borderColor: 'transparent',
      backgroundColor: BAND_COLOR,
      pointRadius: 0,
      fill: '+1',  // fill to next dataset (lower)
      tension: 0.3,
    },
    // Lower band boundary
    {
      label: mode === 'minmax' ? 'Min' : '−1σ',
      data: lowers,
      borderColor: 'transparent',
      backgroundColor: BAND_COLOR,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
    },
    // Mean line
    {
      label: `Mean (${series.length} runs)`,
      data: means,
      borderColor: MEAN_COLOR,
      backgroundColor: MEAN_COLOR,
      pointRadius: 0,
      borderWidth: 2,
      fill: false,
      tension: 0.3,
    },
  ];

  return { labels, datasets };
}

export function MinMaxMeanBands({ runs, defaultMetric }: MinMaxMeanBandsProps) {
  const [selectedMetric, setSelectedMetric] = useState(defaultMetric || '');
  const [bandMode, setBandMode] = useState<BandMode>('minmax');
  const [logScale, setLogScale] = useState(false);

  // Collect all metrics that have time-series data
  const metrics = useMemo(() => {
    const s = new Set<string>();
    runs.forEach(r => Object.keys(r.metricSeries).forEach(k => s.add(k)));
    return [...s];
  }, [runs]);

  const activeMetric = selectedMetric || metrics[0] || '';

  // Gather series for active metric (only runs that have it)
  const series = useMemo(() =>
    runs
      .map(r => r.metricSeries[activeMetric])
      .filter((s): s is number[] => Array.isArray(s) && s.length > 0),
    [runs, activeMetric]
  );

  const { labels, datasets } = useMemo(
    () => buildBandDatasets(series, bandMode),
    [series, bandMode]
  );

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { intersect: false, mode: 'index' as const },
    plugins: {
      legend: {
        position: 'top' as const,
        labels: { filter: (item: any) => item.text !== 'transparent' },
      },
      title: { display: false },
      tooltip: {
        callbacks: {
          label: (item: any) => {
            const v = item.raw as number;
            return `${item.dataset.label}: ${v.toPrecision(4)}`;
          },
        },
      },
    },
    scales: {
      x: {
        title: { display: true, text: 'Step', font: { size: 11 } },
        ticks: { maxTicksLimit: 10 },
      },
      y: {
        type: logScale ? ('logarithmic' as const) : ('linear' as const),
        title: { display: true, text: activeMetric, font: { size: 11 } },
      },
    },
  }), [logScale, activeMetric]);

  if (runs.length === 0) {
    return <div className="text-center py-12 text-gray-400 text-sm">No runs with time-series data.</div>;
  }

  if (metrics.length === 0) {
    return <div className="text-center py-12 text-gray-400 text-sm">No time-series metrics found. Runs need step-by-step metric data.</div>;
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
          <label className="text-sm font-medium text-gray-700">Band</label>
          <div className="flex rounded-md overflow-hidden ring-1 ring-gray-300 text-xs">
            {(['minmax', 'std'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setBandMode(mode)}
                className={`px-3 py-1.5 font-medium transition-colors ${
                  bandMode === mode ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {mode === 'minmax' ? 'Min/Max' : '±Std'}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={logScale}
            onChange={e => setLogScale(e.target.checked)}
            className="rounded accent-indigo-600"
          />
          Log scale
        </label>

        <span className="text-xs text-gray-400">
          {series.length} of {runs.length} runs have <em>{activeMetric}</em> time-series
        </span>
      </div>

      {/* Chart */}
      {series.length >= 1 ? (
        <div className="h-80">
          <Line data={{ labels, datasets }} options={chartOptions} />
        </div>
      ) : (
        <div className="text-center py-8 text-gray-400 text-sm">
          No time-series data for <strong>{activeMetric}</strong>.
          Runs need step-by-step values (not just a final scalar).
        </div>
      )}

      {series.length === 1 && (
        <p className="text-xs text-amber-600 text-center">
          Only 1 run with this metric — bands require at least 2 runs.
        </p>
      )}
    </div>
  );
}

export default MinMaxMeanBands;
