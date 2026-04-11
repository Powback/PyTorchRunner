/**
 * PyTorchRunner Experiment Comparison
 * Compare multiple experiments side-by-side with multi-metric charts,
 * hyperparameter correlation analysis, and statistical significance testing.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Line, Bar, Radar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  RadarController,
  RadialLinearScale,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  RadarController,
  RadialLinearScale,
  Title,
  Tooltip,
  Legend,
  Filler
);

import type { PyTorchExperiment, MetricsChartData } from '../../types/pytorch';

interface ExperimentComparisonProps {
  experimentIds: number[];
  onExperimentRemove?: (id: number) => void;
  onAddExperiment?: () => void;
}

interface ComparisonData {
  experiments: PyTorchExperiment[];
  commonMetrics: string[];
  metricComparisons: Record<string, {
    values: number[];
    best: number;
    worst: number;
    avg: number;
    stdDev: number;
    improvement: number;
  }>;
}

interface StatTest {
  metric: string;
  pValue: number;
  significant: boolean;
  effect: 'large' | 'medium' | 'small' | 'none';
}

const COLORS = [
  { border: 'rgb(239, 68, 68)',   bg: 'rgba(239, 68, 68, 0.15)' },   // red
  { border: 'rgb(34, 197, 94)',   bg: 'rgba(34, 197, 94, 0.15)' },   // green
  { border: 'rgb(59, 130, 246)',  bg: 'rgba(59, 130, 246, 0.15)' },  // blue
  { border: 'rgb(168, 85, 247)',  bg: 'rgba(168, 85, 247, 0.15)' },  // purple
  { border: 'rgb(245, 158, 11)',  bg: 'rgba(245, 158, 11, 0.15)' },  // amber
  { border: 'rgb(236, 72, 153)',  bg: 'rgba(236, 72, 153, 0.15)' },  // pink
];

// Simple approximation of Cohen's d effect size
function cohensD(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  const varA = a.reduce((s, v) => s + (v - meanA) ** 2, 0) / (a.length - 1);
  const varB = b.reduce((s, v) => s + (v - meanB) ** 2, 0) / (b.length - 1);
  const pooled = Math.sqrt((varA + varB) / 2);
  return pooled === 0 ? 0 : Math.abs(meanA - meanB) / pooled;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

export function ExperimentComparison({
  experimentIds,
  onExperimentRemove,
  onAddExperiment
}: ExperimentComparisonProps) {
  const [comparisonData, setComparisonData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<string>('loss');
  const [viewMode, setViewMode] = useState<'overview' | 'curves' | 'correlation' | 'stats'>('overview');
  const chartRef = useRef<any>(null);

  useEffect(() => {
    if (experimentIds.length === 0) {
      setComparisonData(null);
      return;
    }
    loadComparisonData();
  }, [experimentIds]);

  const loadComparisonData = async () => {
    if (experimentIds.length < 2) {
      setError('Need at least 2 experiments to compare');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Mock data — replace with real Powsync/API query
      const mockExperiments: PyTorchExperiment[] = experimentIds.map((id, index) => {
        const lrBase = 0.001 * (index + 1);
        const bsBase = 32 * (2 ** index);
        const noise = () => (Math.random() - 0.5) * 0.05;

        return {
          id,
          name: `Experiment ${id}`,
          description: `Training run #${index + 1} — LR=${lrBase.toFixed(4)}, BS=${bsBase}`,
          status: 'completed',
          projectId: 1,
          createdBy: 'user',
          createdAt: Date.now() - (index + 1) * 86400000,
          startedAt: Date.now() - (index + 1) * 86400000,
          completedAt: Date.now() - (index + 1) * 86400000 + 3600000 * (index + 1),
          config: { hyperparameters: { learning_rate: lrBase, batch_size: bsBase, epochs: 50 } },
          hyperparameters: { learning_rate: lrBase, batch_size: bsBase, epochs: 50, weight_decay: 1e-4 * (index + 1), dropout: 0.1 * index },
          metrics: {
            loss: Array.from({ length: 50 }, (_, i) =>
              Math.max(0.05, Math.exp(-i * 0.07 * (1 + index * 0.1)) * (1 + noise()))
            ),
            accuracy: Array.from({ length: 50 }, (_, i) =>
              Math.min(0.99, 0.5 + (0.45 / (1 + Math.exp(-0.2 * (i - 20)))) * (1 - 0.05 * index) + noise())
            ),
            val_loss: Array.from({ length: 50 }, (_, i) =>
              Math.max(0.08, Math.exp(-i * 0.06 * (1 + index * 0.08)) * (1.1 + noise()))
            ),
            val_accuracy: Array.from({ length: 50 }, (_, i) =>
              Math.min(0.98, 0.48 + (0.43 / (1 + Math.exp(-0.18 * (i - 22)))) * (1 - 0.07 * index) + noise())
            ),
          },
          finalMetrics: {
            loss: 0.08 + 0.04 * index + Math.random() * 0.02,
            accuracy: 0.96 - 0.03 * index + Math.random() * 0.01,
            val_loss: 0.12 + 0.05 * index + Math.random() * 0.02,
            val_accuracy: 0.93 - 0.03 * index + Math.random() * 0.01,
          },
          modelPath: '',
          checkpointPath: '',
          logPath: '',
          tags: `run-${index + 1},lr-${lrBase}`,
          notes: '',
          parentExperimentId: 0,
        };
      });

      const commonMetrics = ['loss', 'accuracy', 'val_loss', 'val_accuracy'];

      const metricComparisons: ComparisonData['metricComparisons'] = {};
      commonMetrics.forEach(metric => {
        const values = mockExperiments.map(exp => exp.finalMetrics[metric] ?? 0);
        const sd = stdDev(values);
        metricComparisons[metric] = {
          values,
          best: metric.includes('loss') ? Math.min(...values) : Math.max(...values),
          worst: metric.includes('loss') ? Math.max(...values) : Math.min(...values),
          avg: values.reduce((a, b) => a + b, 0) / values.length,
          stdDev: sd,
          improvement: values[values.length - 1] - values[0],
        };
      });

      setComparisonData({ experiments: mockExperiments, commonMetrics, metricComparisons });
      if (!commonMetrics.includes(selectedMetric)) setSelectedMetric(commonMetrics[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load comparison data');
    } finally {
      setLoading(false);
    }
  };

  // Statistical significance tests (approximation via effect size)
  const statTests: StatTest[] = useMemo(() => {
    if (!comparisonData || comparisonData.experiments.length < 2) return [];
    const [exp0, exp1] = comparisonData.experiments;

    return comparisonData.commonMetrics.map(metric => {
      const a = exp0.metrics[metric] ?? [];
      const b = exp1.metrics[metric] ?? [];
      const d = cohensD(a, b);

      // Approximate p-value from Cohen's d (very rough, for display only)
      const pApprox = d === 0 ? 1.0 : Math.max(0.001, 1 / (1 + d * 3));

      return {
        metric,
        pValue: pApprox,
        significant: pApprox < 0.05,
        effect: d >= 0.8 ? 'large' : d >= 0.5 ? 'medium' : d >= 0.2 ? 'small' : 'none',
      };
    });
  }, [comparisonData]);

  // Training curves chart for selected metric
  const curvesChartData: MetricsChartData = useMemo(() => {
    if (!comparisonData) return { datasets: [] };
    return {
      datasets: comparisonData.experiments.map((exp, i) => ({
        label: exp.name,
        data: (exp.metrics[selectedMetric] ?? []).map((y, x) => ({ x, y })),
        borderColor: COLORS[i % COLORS.length].border,
        backgroundColor: COLORS[i % COLORS.length].bg,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
      })),
    };
  }, [comparisonData, selectedMetric]);

  // Bar chart for final metric values
  const finalMetricsBarData = useMemo(() => {
    if (!comparisonData) return null;
    return {
      labels: comparisonData.experiments.map(e => e.name),
      datasets: comparisonData.commonMetrics.map((metric, mi) => ({
        label: metric,
        data: comparisonData.experiments.map(exp => exp.finalMetrics[metric] ?? 0),
        backgroundColor: COLORS[mi % COLORS.length].bg,
        borderColor: COLORS[mi % COLORS.length].border,
        borderWidth: 2,
      })),
    };
  }, [comparisonData]);

  // Radar chart — normalised final metrics (0–1)
  const radarData = useMemo(() => {
    if (!comparisonData) return null;
    const metrics = comparisonData.commonMetrics;

    // Normalise each metric to [0,1] range across experiments
    const normalised = metrics.map(m => {
      const vals = comparisonData.experiments.map(e => e.finalMetrics[m] ?? 0);
      const min = Math.min(...vals), max = Math.max(...vals);
      const range = max - min || 1;
      // For loss metrics, invert so higher = better
      const isLoss = m.includes('loss');
      return vals.map(v => isLoss ? 1 - (v - min) / range : (v - min) / range);
    });

    return {
      labels: metrics,
      datasets: comparisonData.experiments.map((exp, i) => ({
        label: exp.name,
        data: metrics.map((_, mi) => normalised[mi][i]),
        borderColor: COLORS[i % COLORS.length].border,
        backgroundColor: COLORS[i % COLORS.length].bg,
        pointBackgroundColor: COLORS[i % COLORS.length].border,
        borderWidth: 2,
      })),
    };
  }, [comparisonData]);

  const formatVal = (metric: string, v: number) =>
    metric.includes('accuracy') ? `${(v * 100).toFixed(1)}%` : v.toFixed(4);

  const formatDuration = (start: number, end: number) => {
    const d = end - start;
    const h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000);
    return `${h}h ${m}m`;
  };

  const curvesOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { intersect: false, mode: 'index' as const },
    scales: {
      x: { title: { display: true, text: 'Epoch' }, type: 'linear' as const },
      y: { title: { display: true, text: selectedMetric } },
    },
    plugins: {
      legend: { position: 'top' as const },
      title: { display: true, text: `${selectedMetric} Training Curves` },
    },
  };

  const barOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' as const },
      title: { display: true, text: 'Final Metrics Comparison' },
    },
  };

  const radarOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: { r: { min: 0, max: 1, ticks: { stepSize: 0.25 } } },
    plugins: {
      legend: { position: 'top' as const },
      title: { display: true, text: 'Normalised Performance Radar' },
    },
  };

  // ── Render states ─────────────────────────────────────────────────────────

  if (experimentIds.length === 0) {
    return (
      <div className="text-center py-12">
        <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5" />
        </svg>
        <h3 className="mt-2 text-sm font-semibold text-gray-900">No experiments to compare</h3>
        <p className="mt-1 text-sm text-gray-500">Select at least 2 experiments to compare.</p>
        {onAddExperiment && (
          <button onClick={onAddExperiment} className="mt-6 inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500">
            Add Experiments
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
        <p className="mt-2 text-sm text-gray-500">Loading comparison data…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <p className="text-sm text-red-800">{error}</p>
      </div>
    );
  }

  if (!comparisonData) return null;

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Experiment Comparison</h2>
            <p className="text-sm text-gray-500">Comparing {comparisonData.experiments.length} experiments</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* View mode tabs */}
            <div className="flex rounded-lg shadow-sm ring-1 ring-gray-300 overflow-hidden text-sm">
              {(['overview', 'curves', 'correlation', 'stats'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-4 py-2 font-medium capitalize transition-colors ${
                    viewMode === mode
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Experiment cards */}
      <div className={`grid gap-4 grid-cols-1 sm:grid-cols-${Math.min(comparisonData.experiments.length, 3)}`}
           style={{ gridTemplateColumns: `repeat(${Math.min(comparisonData.experiments.length, 3)}, minmax(0, 1fr))` }}>
        {comparisonData.experiments.map((exp, i) => (
          <div key={exp.id} className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length].border }} />
                <h3 className="text-sm font-medium text-gray-900">{exp.name}</h3>
              </div>
              {onExperimentRemove && (
                <button onClick={() => onExperimentRemove(exp.id)} className="text-gray-300 hover:text-red-500 transition-colors">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            <div className="space-y-1.5 text-xs text-gray-600">
              <div className="flex justify-between">
                <span>Duration</span>
                <span className="text-gray-900 font-medium">{formatDuration(exp.startedAt, exp.completedAt)}</span>
              </div>
              {Object.entries(exp.hyperparameters).slice(0, 3).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="truncate max-w-[120px]">{k.replace(/_/g, ' ')}</span>
                  <span className="text-gray-900 font-mono">{typeof v === 'number' ? v.toString() : String(v)}</span>
                </div>
              ))}
            </div>

            <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2">
              {comparisonData.commonMetrics.slice(0, 2).map(m => (
                <div key={m} className="text-center">
                  <div className="text-xs text-gray-500">{m}</div>
                  <div className={`text-sm font-semibold ${
                    exp.finalMetrics[m] === comparisonData.metricComparisons[m].best
                      ? 'text-green-600'
                      : exp.finalMetrics[m] === comparisonData.metricComparisons[m].worst
                      ? 'text-red-500'
                      : 'text-gray-900'
                  }`}>
                    {formatVal(m, exp.finalMetrics[m] ?? 0)}
                    {exp.finalMetrics[m] === comparisonData.metricComparisons[m].best && ' ★'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── Overview ── */}
      {viewMode === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Final metrics bar chart */}
          {finalMetricsBarData && (
            <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
              <div className="h-72">
                <Bar data={finalMetricsBarData} options={barOptions} />
              </div>
            </div>
          )}

          {/* Radar chart */}
          {radarData && (
            <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
              <div className="h-72">
                <Radar data={radarData} options={radarOptions} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Training curves ── */}
      {viewMode === 'curves' && (
        <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium text-gray-700">Metric</label>
            <select
              value={selectedMetric}
              onChange={e => setSelectedMetric(e.target.value)}
              className="rounded-md border-gray-300 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            >
              {comparisonData.commonMetrics.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="h-96">
            <Line ref={chartRef} data={curvesChartData} options={curvesOptions} />
          </div>
        </div>
      )}

      {/* ── Hyperparameter Correlation ── */}
      {viewMode === 'correlation' && (
        <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Hyperparameter vs Metric Correlation</h3>
            <p className="text-xs text-gray-500 mt-1">
              Cell color indicates performance relative to best value. Green = closer to best, Red = further.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Experiment</th>
                  {Object.keys(comparisonData.experiments[0].hyperparameters).map(hp => (
                    <th key={hp} className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">
                      {hp.replace(/_/g, ' ')}
                    </th>
                  ))}
                  {comparisonData.commonMetrics.map(m => (
                    <th key={m} className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {comparisonData.experiments.map((exp, i) => (
                  <tr key={exp.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length].border }} />
                        <span className="font-medium text-gray-900">{exp.name}</span>
                      </div>
                    </td>

                    {Object.values(exp.hyperparameters).map((v, vi) => (
                      <td key={vi} className="px-4 py-3 text-center font-mono text-gray-700">
                        {typeof v === 'number' ? v.toExponential ? (v < 0.01 ? v.toExponential(1) : String(v)) : String(v) : String(v)}
                      </td>
                    ))}

                    {comparisonData.commonMetrics.map(m => {
                      const val = exp.finalMetrics[m] ?? 0;
                      const { best, worst } = comparisonData.metricComparisons[m];
                      const range = Math.abs(best - worst) || 1;
                      const normalised = Math.abs(val - worst) / range; // 0 = worst, 1 = best
                      const r = Math.round(255 * (1 - normalised));
                      const g = Math.round(200 * normalised);
                      const bgColor = `rgba(${r}, ${g}, 60, 0.15)`;
                      const textColor = normalised > 0.6 ? 'text-green-700' : normalised < 0.3 ? 'text-red-600' : 'text-gray-700';

                      return (
                        <td key={m} className="px-4 py-3 text-center" style={{ backgroundColor: bgColor }}>
                          <span className={`font-semibold ${textColor}`}>{formatVal(m, val)}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Statistical Analysis ── */}
      {viewMode === 'stats' && (
        <div className="space-y-6">
          {/* Summary stats table */}
          <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Summary Statistics</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Metric</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Best</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Worst</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Mean</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Std Dev</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Range</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">CV %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {comparisonData.commonMetrics.map(m => {
                    const s = comparisonData.metricComparisons[m];
                    const range = Math.abs(s.best - s.worst);
                    const cv = s.avg !== 0 ? (s.stdDev / Math.abs(s.avg)) * 100 : 0;
                    return (
                      <tr key={m} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{m}</td>
                        <td className="px-4 py-3 text-center text-green-600 font-semibold">{formatVal(m, s.best)}</td>
                        <td className="px-4 py-3 text-center text-red-500 font-semibold">{formatVal(m, s.worst)}</td>
                        <td className="px-4 py-3 text-center text-gray-700">{formatVal(m, s.avg)}</td>
                        <td className="px-4 py-3 text-center text-gray-600 font-mono">{s.stdDev.toFixed(4)}</td>
                        <td className="px-4 py-3 text-center text-gray-600 font-mono">{range.toFixed(4)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`font-mono text-xs px-1.5 py-0.5 rounded ${cv > 20 ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'}`}>
                            {cv.toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Effect size / significance (pairwise, first two experiments) */}
          {statTests.length > 0 && comparisonData.experiments.length >= 2 && (
            <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h3 className="text-sm font-semibold text-gray-900">
                  Statistical Significance — {comparisonData.experiments[0].name} vs {comparisonData.experiments[1].name}
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  Effect size (Cohen's d) and approximate significance over training curve values. Indicative only.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Metric</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Effect Size</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Magnitude</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">p-value (approx)</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Significant?</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {statTests.map(t => (
                      <tr key={t.metric} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{t.metric}</td>
                        <td className="px-4 py-3 text-center font-mono text-gray-700">{(1 / (t.pValue * 3 + 0.01) - 1).toFixed(2)}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                            t.effect === 'large' ? 'bg-green-100 text-green-800' :
                            t.effect === 'medium' ? 'bg-blue-100 text-blue-800' :
                            t.effect === 'small' ? 'bg-yellow-100 text-yellow-800' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {t.effect}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center font-mono text-gray-600">{t.pValue.toFixed(3)}</td>
                        <td className="px-4 py-3 text-center">
                          {t.significant
                            ? <span className="inline-flex items-center gap-1 text-green-700 font-medium"><span>✓</span> Yes</span>
                            : <span className="text-gray-400">No</span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Performance trend summary */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {comparisonData.commonMetrics.map(m => {
              const s = comparisonData.metricComparisons[m];
              const isLoss = m.includes('loss');
              const goodImprovement = isLoss ? s.improvement < 0 : s.improvement > 0;
              return (
                <div key={m} className="bg-gray-50 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-900">{m}</span>
                    <span className={`text-lg ${goodImprovement ? 'text-green-500' : 'text-red-400'}`}>
                      {goodImprovement ? '↗' : '↘'}
                    </span>
                  </div>
                  <div className="space-y-1 text-xs text-gray-600">
                    <div className="flex justify-between">
                      <span>Best</span>
                      <span className="font-medium text-green-600">{formatVal(m, s.best)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Avg ± σ</span>
                      <span className="font-mono">{formatVal(m, s.avg)} ±{s.stdDev.toFixed(3)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Δ first→last</span>
                      <span className={`font-medium ${goodImprovement ? 'text-green-600' : 'text-red-500'}`}>
                        {s.improvement > 0 ? '+' : ''}{s.improvement.toFixed(4)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default ExperimentComparison;
