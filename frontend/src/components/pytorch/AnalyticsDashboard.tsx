/**
 * PyTorchRunner Analytics Dashboard
 * High-level overview of all experiments: performance trends, top runs,
 * metric distributions, and hyperparameter impact analysis.
 *
 * Data source: real jobs fetched from the backend API via Powsync bridge.
 * No mock data — charts reflect actual training history.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Bar, Line, Scatter } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ScatterController,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ScatterController, Title, Tooltip, Legend, Filler);

import { pytorchAPI } from '../../lib/pytorch/api-client';
import type { PyTorchExperiment } from '../../types/pytorch';

// ── Transform raw job record to PyTorchExperiment shape ───────────────────────

function transformJob(job: any): PyTorchExperiment {
  const createdAt = job.created_at ? new Date(job.created_at).getTime() : Date.now();
  const startedAt = job.started_at ? new Date(job.started_at).getTime() : 0;
  const completedAt = job.completed_at ? new Date(job.completed_at).getTime() : 0;

  // env_vars may carry hyperparameters set by the submitter
  const envVars: Record<string, any> = typeof job.env_vars === 'object' && job.env_vars
    ? job.env_vars
    : {};

  // metrics_summary holds the last known values per metric (populated by
  // _store_metrics as metrics are detected from stdout / metrics.jsonl)
  const finalMetrics: Record<string, number> =
    typeof job.metrics_summary === 'object' && job.metrics_summary
      ? job.metrics_summary
      : {};

  return {
    id: job.id ?? Date.now(),
    name: job.job_name || `job-${(job.job_id ?? '').slice(0, 8)}`,
    description: job.script || '',
    status: job.status ?? 'queued',
    projectId: 0,
    createdBy: job.namespace || 'default',
    createdAt,
    startedAt,
    completedAt,
    config: {},
    hyperparameters: envVars,
    metrics: {},  // time-series data not included in list view
    finalMetrics,
    modelPath: '',
    checkpointPath: '',
    logPath: '',
    tags: Array.isArray(job.tags) ? job.tags.join(',') : (job.tags || ''),
    notes: '',
    parentExperimentId: 0,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  running:   'bg-blue-100 text-blue-800',
  failed:    'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-700',
  draft:     'bg-yellow-100 text-yellow-800',
  queued:    'bg-purple-100 text-purple-800',
};

const CHART_COLORS = [
  'rgba(99, 102, 241, 0.8)',
  'rgba(34, 197, 94, 0.8)',
  'rgba(239, 68, 68, 0.8)',
  'rgba(245, 158, 11, 0.8)',
  'rgba(168, 85, 247, 0.8)',
  'rgba(59, 130, 246, 0.8)',
];

type SortKey = 'accuracy' | 'loss' | 'duration' | 'created';

// ── Component ─────────────────────────────────────────────────────────────────

export function AnalyticsDashboard() {
  const [experiments, setExperiments] = useState<PyTorchExperiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('created');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'overview' | 'trends' | 'hyperparams' | 'leaderboard'>('overview');

  // ── Fetch real data from the backend ─────────────────────────────────

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);

    pytorchAPI
      .listExperiments({ limit: 100 })
      .then(jobs => {
        if (mounted) setExperiments(jobs.map(transformJob));
      })
      .catch(err => {
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load experiments');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, []);

  const completed = experiments.filter(e => e.status === 'completed');

  // ── Summary statistics ────────────────────────────────────────────────

  const summary = useMemo(() => {
    const byStatus = experiments.reduce((acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const accuracies = completed.map(e => e.finalMetrics.accuracy ?? 0).filter(Boolean);
    const losses = completed.map(e => e.finalMetrics.loss ?? 0).filter(Boolean);
    const durations = completed
      .filter(e => e.completedAt > 0 && e.startedAt > 0)
      .map(e => (e.completedAt - e.startedAt) / 60000);

    return {
      total: experiments.length,
      byStatus,
      bestAccuracy: accuracies.length ? Math.max(...accuracies) : null,
      avgAccuracy: accuracies.length ? accuracies.reduce((a, b) => a + b) / accuracies.length : null,
      bestLoss: losses.length ? Math.min(...losses) : null,
      avgDuration: durations.length ? durations.reduce((a, b) => a + b) / durations.length : null,
    };
  }, [experiments, completed]);

  // ── Filtered + sorted experiments ─────────────────────────────────────

  const displayExperiments = useMemo(() => {
    let list = statusFilter === 'all' ? experiments : experiments.filter(e => e.status === statusFilter);
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'accuracy': return (b.finalMetrics.accuracy ?? -1) - (a.finalMetrics.accuracy ?? -1);
        case 'loss':     return (a.finalMetrics.loss ?? 999) - (b.finalMetrics.loss ?? 999);
        case 'duration': return (b.completedAt - b.startedAt) - (a.completedAt - a.startedAt);
        case 'created':  return b.createdAt - a.createdAt;
        default:         return 0;
      }
    });
  }, [experiments, sortKey, statusFilter]);

  // ── Accuracy over time (trend) ────────────────────────────────────────

  const trendChartData = useMemo(() => {
    const sorted = [...completed].sort((a, b) => a.startedAt - b.startedAt);
    return {
      labels: sorted.map(e => new Date(e.startedAt).toLocaleDateString()),
      datasets: [
        {
          label: 'Final Accuracy',
          data: sorted.map(e => e.finalMetrics.accuracy ? +(e.finalMetrics.accuracy * 100).toFixed(2) : null),
          borderColor: 'rgb(99, 102, 241)',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          tension: 0.3,
          fill: true,
          pointRadius: 5,
        },
        {
          label: 'Val Accuracy',
          data: sorted.map(e => e.finalMetrics.val_accuracy ? +(e.finalMetrics.val_accuracy * 100).toFixed(2) : null),
          borderColor: 'rgb(34, 197, 94)',
          backgroundColor: 'rgba(34, 197, 94, 0.05)',
          tension: 0.3,
          fill: false,
          borderDash: [5, 3],
          pointRadius: 4,
        },
      ],
    };
  }, [completed]);

  // ── Status breakdown bar chart ────────────────────────────────────────

  const statusChartData = {
    labels: Object.keys(summary.byStatus),
    datasets: [{
      label: 'Experiments',
      data: Object.values(summary.byStatus),
      backgroundColor: Object.keys(summary.byStatus).map(s =>
        s === 'completed' ? 'rgba(34, 197, 94, 0.7)' :
        s === 'failed'    ? 'rgba(239, 68, 68, 0.7)' :
        s === 'running'   ? 'rgba(59, 130, 246, 0.7)' :
        'rgba(156, 163, 175, 0.7)'
      ),
      borderWidth: 0,
      borderRadius: 4,
    }],
  };

  // ── Loss trend (if available) ─────────────────────────────────────────

  const lossTrendData = useMemo(() => {
    const sorted = [...completed]
      .filter(e => e.finalMetrics.loss)
      .sort((a, b) => a.startedAt - b.startedAt);
    return {
      labels: sorted.map(e => new Date(e.startedAt).toLocaleDateString()),
      datasets: [{
        label: 'Final Loss',
        data: sorted.map(e => e.finalMetrics.loss ? +e.finalMetrics.loss.toFixed(4) : null),
        borderColor: 'rgb(239, 68, 68)',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 5,
      }],
    };
  }, [completed]);

  const trendOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      y: { title: { display: true, text: 'Accuracy (%)' }, min: 0, max: 100 },
    },
    plugins: {
      legend: { position: 'top' as const },
      title: { display: true, text: 'Accuracy Trend Over Runs' },
    },
  };

  const statusOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: true, text: 'Experiments by Status' },
    },
    scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
  };

  const fmtDur = (ms: number) => {
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  // ── Loading / error states ────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-r-transparent" />
          <p className="mt-3 text-sm text-gray-500">Loading experiment data…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 p-6 text-center">
        <p className="text-sm font-medium text-red-800">Failed to load experiments</p>
        <p className="mt-1 text-xs text-red-600">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-3 text-xs text-red-700 underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Experiments', value: summary.total, sub: `${summary.byStatus.running ?? 0} running`, color: 'indigo' },
          { label: 'Best Accuracy', value: summary.bestAccuracy ? `${(summary.bestAccuracy * 100).toFixed(1)}%` : '—', sub: summary.avgAccuracy ? `avg ${(summary.avgAccuracy * 100).toFixed(1)}%` : 'no accuracy data', color: 'green' },
          { label: 'Best Loss', value: summary.bestLoss ? summary.bestLoss.toFixed(4) : '—', sub: `${summary.byStatus.completed ?? 0} completed`, color: 'blue' },
          { label: 'Avg Duration', value: summary.avgDuration ? `${summary.avgDuration.toFixed(0)}m` : '—', sub: `${summary.byStatus.failed ?? 0} failed`, color: 'purple' },
        ].map(card => (
          <div key={card.label} className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-5">
            <div className="text-xs font-medium text-gray-500 truncate">{card.label}</div>
            <div className={`mt-1 text-2xl font-bold text-${card.color}-600`}>{card.value}</div>
            <div className="mt-1 text-xs text-gray-400">{card.sub}</div>
          </div>
        ))}
      </div>

      {/* Empty state */}
      {experiments.length === 0 && (
        <div className="rounded-lg bg-gray-50 border border-gray-200 p-10 text-center">
          <p className="text-sm font-medium text-gray-700">No experiments yet</p>
          <p className="mt-1 text-xs text-gray-500">
            Submit a training job and metrics will appear here in real-time.
          </p>
        </div>
      )}

      {experiments.length > 0 && (
        <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg overflow-hidden">
          {/* Tab navigation */}
          <div className="border-b border-gray-200">
            <div className="flex -mb-px">
              {(['overview', 'trends', 'leaderboard'] as const).map((tab: string) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-5 py-3 text-sm font-medium capitalize border-b-2 transition-colors ${
                    activeTab === tab
                      ? 'border-indigo-500 text-indigo-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          <div className="p-6">
            {/* ── Overview ── */}
            {activeTab === 'overview' && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="h-64">
                  {Object.keys(summary.byStatus).length > 0
                    ? <Bar data={statusChartData} options={statusOptions} />
                    : <p className="text-sm text-gray-400 text-center pt-20">No status data</p>
                  }
                </div>
                <div className="h-64">
                  {completed.length > 0
                    ? <Line data={trendChartData} options={trendOptions} />
                    : <div className="flex items-center justify-center h-full">
                        <p className="text-sm text-gray-400">No completed experiments yet</p>
                      </div>
                  }
                </div>
              </div>
            )}

            {/* ── Trends ── */}
            {activeTab === 'trends' && (
              <div className="space-y-6">
                {completed.some(e => e.finalMetrics.accuracy) ? (
                  <div className="h-80">
                    <Line data={trendChartData} options={{ ...trendOptions, maintainAspectRatio: false }} />
                  </div>
                ) : null}

                {completed.some(e => e.finalMetrics.loss) ? (
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 mb-3">Loss Trend</h3>
                    <div className="h-64">
                      <Line
                        data={lossTrendData}
                        options={{
                          responsive: true,
                          maintainAspectRatio: false,
                          scales: { y: { title: { display: true, text: 'Loss' }, beginAtZero: false } },
                          plugins: { legend: { display: false }, title: { display: true, text: 'Final Loss Over Runs' } },
                        }}
                      />
                    </div>
                  </div>
                ) : null}

                {!completed.some(e => e.finalMetrics.accuracy || e.finalMetrics.loss) && (
                  <div className="text-center py-12 text-gray-400">
                    <p className="text-sm">No metric data yet.</p>
                    <p className="text-xs mt-1">
                      Metrics are collected automatically from training script output.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Leaderboard ── */}
            {activeTab === 'leaderboard' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-500 mr-2">Sort by</label>
                    <select
                      value={sortKey}
                      onChange={e => setSortKey(e.target.value as SortKey)}
                      className="text-sm rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    >
                      <option value="created">Most Recent</option>
                      <option value="accuracy">Best Accuracy</option>
                      <option value="loss">Best Loss</option>
                      <option value="duration">Duration</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 mr-2">Status</label>
                    <select
                      value={statusFilter}
                      onChange={e => setStatusFilter(e.target.value)}
                      className="text-sm rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    >
                      <option value="all">All</option>
                      <option value="completed">Completed</option>
                      <option value="running">Running</option>
                      <option value="failed">Failed</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex-1" />
                  <a
                    href="/analysis"
                    className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
                  >
                    Advanced Hyperparameter Analysis
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                    </svg>
                  </a>
                </div>

                <div className="overflow-x-auto rounded-lg ring-1 ring-gray-200">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-8">#</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Experiment</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Accuracy</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Loss</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Duration</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tags</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {displayExperiments.map((exp, rank) => (
                        <tr key={exp.id} className={`hover:bg-gray-50 ${rank === 0 ? 'bg-indigo-50/40' : ''}`}>
                          <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                            {rank === 0 && sortKey === 'accuracy' ? '🏆' : rank + 1}
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900 truncate max-w-[200px]">{exp.name}</div>
                            <div className="text-xs text-gray-400 truncate max-w-[200px]">{exp.description}</div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[exp.status] ?? ''}`}>
                              {exp.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center font-semibold text-gray-900">
                            {exp.finalMetrics.accuracy
                              ? `${(exp.finalMetrics.accuracy * 100).toFixed(1)}%`
                              : '—'}
                          </td>
                          <td className="px-4 py-3 text-center font-mono text-gray-700">
                            {exp.finalMetrics.loss ? exp.finalMetrics.loss.toFixed(4) : '—'}
                          </td>
                          <td className="px-4 py-3 text-center text-gray-500 text-xs">
                            {exp.completedAt > 0 && exp.startedAt > 0
                              ? fmtDur(exp.completedAt - exp.startedAt)
                              : exp.status === 'running' ? 'in progress' : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {(exp.tags || '').split(',').filter(Boolean).slice(0, 3).map(tag => (
                                <span key={tag} className="inline-flex px-1.5 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">
                                  {tag.trim()}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default AnalyticsDashboard;
