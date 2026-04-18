/**
 * HyperparameterCorrelation
 * Scatter plot matrix: for each (hyperparameter, metric) pair, one scatter plot
 * where X = param value across runs and Y = final metric value.
 * Each dot = one run. Best runs highlighted.
 */

import React, { useMemo, useState } from 'react';
import { Scatter } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  LinearScale,
  LogarithmicScale,
  PointElement,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(LinearScale, LogarithmicScale, PointElement, Tooltip, Legend);

export interface RunDataPoint {
  jobId: string;
  name: string;
  hyperparams: Record<string, number>;  // numeric env_vars
  finalMetrics: Record<string, number>; // metrics_summary
  status: string;
}

interface HyperparameterCorrelationProps {
  runs: RunDataPoint[];
  maxPlots?: number; // max number of scatter plots to show
}

const COLORS = {
  best:    'rgba(34, 197, 94, 0.9)',
  good:    'rgba(59, 130, 246, 0.75)',
  ok:      'rgba(168, 85, 247, 0.65)',
  poor:    'rgba(239, 68, 68, 0.65)',
  default: 'rgba(100, 116, 139, 0.6)',
};

function pearsonR(xs: number[], ys: number[]): number {
  if (xs.length < 2) return 0;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const denom = Math.sqrt(
    xs.reduce((s, x) => s + (x - mx) ** 2, 0) *
    ys.reduce((s, y) => s + (y - my) ** 2, 0)
  );
  return denom === 0 ? 0 : num / denom;
}

function formatNum(v: number): string {
  if (Math.abs(v) < 0.001 && v !== 0) return v.toExponential(2);
  if (Number.isInteger(v)) return String(v);
  return v.toPrecision(4).replace(/\.?0+$/, '');
}

export function HyperparameterCorrelation({
  runs,
  maxPlots = 12,
}: HyperparameterCorrelationProps) {
  const [selectedMetric, setSelectedMetric] = useState<string>('');

  // Collect all numeric hyperparameters and metrics seen across runs
  const { hyperparams, metrics } = useMemo(() => {
    const hpSet = new Set<string>();
    const mSet = new Set<string>();
    for (const r of runs) {
      Object.keys(r.hyperparams).forEach(k => hpSet.add(k));
      Object.keys(r.finalMetrics).forEach(k => mSet.add(k));
    }
    return {
      hyperparams: [...hpSet].filter(hp =>
        runs.some(r => r.hyperparams[hp] !== undefined)
      ),
      metrics: [...mSet].filter(m =>
        runs.some(r => r.finalMetrics[m] !== undefined)
      ),
    };
  }, [runs]);

  const activeMetric = selectedMetric || metrics[0] || '';

  // Determine "best" run for highlighting — lowest loss or highest accuracy
  const bestRunId = useMemo(() => {
    if (!activeMetric || runs.length === 0) return '';
    const isLoss = activeMetric.toLowerCase().includes('loss') ||
                   activeMetric.toLowerCase().includes('error');
    let best = runs[0];
    for (const r of runs) {
      const v = r.finalMetrics[activeMetric];
      const bv = best.finalMetrics[activeMetric];
      if (v === undefined) continue;
      if (bv === undefined || (isLoss ? v < bv : v > bv)) best = r;
    }
    return best.jobId;
  }, [runs, activeMetric]);

  // Build scatter plots: one per hyperparameter for the selected metric
  const plots = useMemo(() => {
    if (!activeMetric) return [];
    return hyperparams.slice(0, maxPlots).map(hp => {
      const points = runs
        .filter(r => r.hyperparams[hp] !== undefined && r.finalMetrics[activeMetric] !== undefined)
        .map(r => ({ x: r.hyperparams[hp], y: r.finalMetrics[activeMetric], run: r }));

      const xs = points.map(p => p.x);
      const ys = points.map(p => p.y);
      const r = pearsonR(xs, ys);

      const isLoss = activeMetric.toLowerCase().includes('loss') ||
                     activeMetric.toLowerCase().includes('error');
      const yVals = ys;
      const yMin = Math.min(...yVals);
      const yMax = Math.max(...yVals);
      const yRange = yMax - yMin || 1;

      const chartData = {
        datasets: [
          {
            label: `${hp} vs ${activeMetric}`,
            data: points.map(p => {
              const norm = (p.y - yMin) / yRange; // 0=worst, 1=best
              const performance = isLoss ? 1 - norm : norm;
              const color = p.run.jobId === bestRunId
                ? COLORS.best
                : performance > 0.75 ? COLORS.good
                : performance > 0.4  ? COLORS.ok
                : COLORS.poor;
              return {
                x: p.x,
                y: p.y,
                backgroundColor: color,
                pointRadius: p.run.jobId === bestRunId ? 8 : 5,
                label: p.run.name,
              };
            }),
            backgroundColor: points.map(p => {
              const norm = (p.y - yMin) / yRange;
              const performance = isLoss ? 1 - norm : norm;
              return p.run.jobId === bestRunId ? COLORS.best
                : performance > 0.75 ? COLORS.good
                : performance > 0.4  ? COLORS.ok
                : COLORS.poor;
            }),
            pointRadius: points.map(p => p.run.jobId === bestRunId ? 8 : 5),
            pointHoverRadius: 9,
          },
        ],
      };

      const options = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false as const,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items: any[]) => {
                const idx = items[0]?.dataIndex;
                return idx !== undefined ? points[idx]?.run.name : '';
              },
              label: (item: any) => {
                const p = points[item.dataIndex];
                return [
                  `${hp}: ${formatNum(p.x)}`,
                  `${activeMetric}: ${formatNum(p.y)}`,
                  p.run.jobId === bestRunId ? '★ Best run' : '',
                ].filter(Boolean);
              },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: hp, font: { size: 11 } },
            ticks: { maxTicksLimit: 5, callback: (v: any) => formatNum(Number(v)) },
          },
          y: {
            title: { display: true, text: activeMetric, font: { size: 11 } },
            ticks: { maxTicksLimit: 5, callback: (v: any) => formatNum(Number(v)) },
          },
        },
      };

      return { hp, r, chartData, options, count: points.length };
    });
  }, [hyperparams, activeMetric, runs, bestRunId, maxPlots]);

  if (runs.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        No runs available for correlation analysis.
      </div>
    );
  }

  if (metrics.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        No metric data found. Submit jobs that log metrics to see correlation plots.
      </div>
    );
  }

  if (hyperparams.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        No numeric hyperparameters found in env_vars. Pass hyperparameters as env vars to see correlation plots.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-4">
        <label className="text-sm font-medium text-gray-700">Target metric</label>
        <select
          value={activeMetric}
          onChange={e => setSelectedMetric(e.target.value)}
          className="rounded-md border border-gray-300 text-sm px-2 py-1.5 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        >
          {metrics.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <span className="text-xs text-gray-400">{runs.length} runs · {hyperparams.length} hyperparameters</span>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        {[
          { color: COLORS.best, label: 'Best run' },
          { color: COLORS.good, label: 'Good (top 25%)' },
          { color: COLORS.ok,   label: 'OK (mid)' },
          { color: COLORS.poor, label: 'Poor (bottom 25%)' },
        ].map(({ color, label }) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </div>

      {/* Scatter plot grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {plots.map(({ hp, r, chartData, options, count }) => (
          <div
            key={hp}
            className="bg-white rounded-lg shadow-sm ring-1 ring-gray-900/5 p-4"
          >
            <div className="flex items-center justify-between mb-1">
              <h4 className="text-xs font-semibold text-gray-700 truncate max-w-[60%]">{hp}</h4>
              <span
                className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                  Math.abs(r) > 0.7 ? 'bg-orange-100 text-orange-700' :
                  Math.abs(r) > 0.4 ? 'bg-yellow-100 text-yellow-700' :
                  'bg-gray-100 text-gray-500'
                }`}
                title="Pearson correlation coefficient"
              >
                r={r.toFixed(2)}
              </span>
            </div>
            <p className="text-xs text-gray-400 mb-2">{count} runs</p>
            <div className="h-44">
              <Scatter data={chartData} options={options} />
            </div>
          </div>
        ))}
      </div>

      {plots.length === 0 && (
        <div className="text-center py-8 text-gray-400 text-sm">
          No data points found for <strong>{activeMetric}</strong> + numeric hyperparameters.
        </div>
      )}
    </div>
  );
}

export default HyperparameterCorrelation;
