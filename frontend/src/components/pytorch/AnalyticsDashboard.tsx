/**
 * PyTorchRunner Analytics Dashboard
 * High-level overview of all experiments: performance trends, top runs,
 * metric distributions, and hyperparameter impact analysis.
 */

import React, { useState, useMemo } from 'react';
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

import type { PyTorchExperiment } from '../../types/pytorch';

// ── Mock data factory (replace with Powsync query) ──────────────────────────

function generateMockExperiments(count = 12): PyTorchExperiment[] {
  const statuses: PyTorchExperiment['status'][] = ['completed', 'completed', 'completed', 'failed', 'running', 'cancelled'];
  const modelTypes = ['ResNet-50', 'BERT-base', 'ViT-B/16', 'EfficientNet', 'GPT-2 small', 'MobileNet'];
  const now = Date.now();

  return Array.from({ length: count }, (_, i) => {
    const lrExp = -(Math.random() * 3 + 1); // 1e-4 to 1e-1
    const lr = parseFloat(Math.pow(10, lrExp).toFixed(6));
    const bs = [16, 32, 64, 128][Math.floor(Math.random() * 4)];
    const epochsTotal = Math.floor(Math.random() * 40 + 10);
    const accuracy = 0.7 + Math.random() * 0.27;
    const loss = 0.05 + Math.random() * 0.5;
    const duration = Math.floor(Math.random() * 7200000 + 600000); // 10min–2hr
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    const startedAt = now - (count - i) * 86400000 * 0.5 - duration;

    return {
      id: i + 1,
      name: `${modelTypes[i % modelTypes.length]} Run ${i + 1}`,
      description: `${modelTypes[i % modelTypes.length]} — LR ${lr}, BS ${bs}`,
      status,
      projectId: 1,
      createdBy: 'user',
      createdAt: startedAt - 5000,
      startedAt,
      completedAt: status === 'running' ? 0 : startedAt + duration,
      config: { hyperparameters: { learning_rate: lr, batch_size: bs, epochs: epochsTotal } },
      hyperparameters: { learning_rate: lr, batch_size: bs, epochs: epochsTotal, weight_decay: 1e-4 },
      metrics: {
        loss: Array.from({ length: epochsTotal }, (_, ep) => Math.max(0.02, loss * Math.exp(-ep * 0.08) + (Math.random() - 0.5) * 0.02)),
        accuracy: Array.from({ length: epochsTotal }, (_, ep) => Math.min(0.99, accuracy * (1 - Math.exp(-ep * 0.1)) + Math.random() * 0.01)),
      },
      finalMetrics: status === 'completed' ? { loss, accuracy, val_loss: loss * 1.1, val_accuracy: accuracy * 0.97 } : {},
      modelPath: '',
      checkpointPath: '',
      logPath: '',
      tags: `${modelTypes[i % modelTypes.length].toLowerCase().replace(/\s/g, '-')},run-${i + 1}`,
      notes: '',
      parentExperimentId: 0,
    };
  });
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  running:   'bg-blue-100 text-blue-800',
  failed:    'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-700',
  draft:     'bg-yellow-100 text-yellow-800',
};

const CHART_COLORS = [
  'rgba(99, 102, 241, 0.8)',   // indigo
  'rgba(34, 197, 94, 0.8)',    // green
  'rgba(239, 68, 68, 0.8)',    // red
  'rgba(245, 158, 11, 0.8)',   // amber
  'rgba(168, 85, 247, 0.8)',   // purple
  'rgba(59, 130, 246, 0.8)',   // blue
];

type SortKey = 'accuracy' | 'loss' | 'duration' | 'created';

export function AnalyticsDashboard() {
  const [experiments] = useState<PyTorchExperiment[]>(() => generateMockExperiments(12));
  const [sortKey, setSortKey] = useState<SortKey>('accuracy');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'overview' | 'trends' | 'hyperparams' | 'leaderboard'>('overview');

  const completed = experiments.filter(e => e.status === 'completed');

  // ── Summary statistics ────────────────────────────────────────────────────

  const summary = useMemo(() => {
    const byStatus = experiments.reduce((acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const accuracies = completed.map(e => e.finalMetrics.accuracy ?? 0).filter(Boolean);
    const losses = completed.map(e => e.finalMetrics.loss ?? 0).filter(Boolean);
    const durations = completed
      .filter(e => e.completedAt > 0)
      .map(e => (e.completedAt - e.startedAt) / 60000); // minutes

    return {
      total: experiments.length,
      byStatus,
      bestAccuracy: accuracies.length ? Math.max(...accuracies) : null,
      avgAccuracy: accuracies.length ? accuracies.reduce((a, b) => a + b) / accuracies.length : null,
      bestLoss: losses.length ? Math.min(...losses) : null,
      avgDuration: durations.length ? durations.reduce((a, b) => a + b) / durations.length : null,
    };
  }, [experiments, completed]);

  // ── Filtered + sorted experiments ─────────────────────────────────────────

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

  // ── Accuracy over time (trend) ────────────────────────────────────────────

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

  // ── Status breakdown bar chart ────────────────────────────────────────────

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

  // ── LR vs Accuracy scatter ────────────────────────────────────────────────

  const lrScatterData = {
    datasets: [{
      label: 'LR vs Accuracy',
      data: completed.map(e => ({
        x: Math.log10(e.hyperparameters.learning_rate as number ?? 1e-3),
        y: (e.finalMetrics.accuracy ?? 0) * 100,
      })),
      backgroundColor: 'rgba(99, 102, 241, 0.6)',
      pointRadius: 7,
      pointHoverRadius: 9,
    }],
  };

  const lrScatterOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { title: { display: true, text: 'log₁₀(Learning Rate)' } },
      y: { title: { display: true, text: 'Accuracy (%)' }, min: 0, max: 100 },
    },
    plugins: {
      legend: { display: false },
      title: { display: true, text: 'Learning Rate vs Final Accuracy' },
      tooltip: {
        callbacks: {
          label: (ctx: any) => `LR: 1e${ctx.parsed.x.toFixed(1)}, Acc: ${ctx.parsed.y.toFixed(1)}%`,
        },
      },
    },
  };

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

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Experiments', value: summary.total, sub: `${summary.byStatus.running ?? 0} running`, color: 'indigo' },
          { label: 'Best Accuracy', value: summary.bestAccuracy ? `${(summary.bestAccuracy * 100).toFixed(1)}%` : '—', sub: summary.avgAccuracy ? `avg ${(summary.avgAccuracy * 100).toFixed(1)}%` : '', color: 'green' },
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

      {/* Tab navigation */}
      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg overflow-hidden">
        <div className="border-b border-gray-200">
          <div className="flex -mb-px">
            {(['overview', 'trends', 'hyperparams', 'leaderboard'] as const).map(tab => (
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
                <Bar data={statusChartData} options={statusOptions} />
              </div>
              <div className="h-64">
                <Line data={trendChartData} options={trendOptions} />
              </div>
            </div>
          )}

          {/* ── Trends ── */}
          {activeTab === 'trends' && (
            <div className="space-y-6">
              <div className="h-80">
                <Line data={trendChartData} options={{ ...trendOptions, maintainAspectRatio: false }} />
              </div>

              {/* Per-epoch performance for top-3 experiments */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Top 3 Runs — Training Curves</h3>
                <div className="h-64">
                  <Line
                    data={{
                      datasets: [...completed]
                        .sort((a, b) => (b.finalMetrics.accuracy ?? 0) - (a.finalMetrics.accuracy ?? 0))
                        .slice(0, 3)
                        .map((exp, i) => ({
                          label: exp.name,
                          data: (exp.metrics.accuracy ?? []).map((y, x) => ({ x, y: y * 100 })),
                          borderColor: ['rgb(99,102,241)', 'rgb(34,197,94)', 'rgb(245,158,11)'][i],
                          backgroundColor: ['rgba(99,102,241,0.1)', 'rgba(34,197,94,0.1)', 'rgba(245,158,11,0.1)'][i],
                          tension: 0.3,
                          pointRadius: 0,
                          fill: true,
                        })),
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      animation: false as any,
                      scales: {
                        x: { title: { display: true, text: 'Epoch' }, type: 'linear' as const },
                        y: { title: { display: true, text: 'Accuracy (%)' }, min: 0, max: 100 },
                      },
                      plugins: { legend: { position: 'top' as const } },
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Hyperparameters ── */}
          {activeTab === 'hyperparams' && (
            <div className="space-y-6">
              <div className="h-72">
                <Scatter data={lrScatterData} options={{ ...lrScatterOptions, maintainAspectRatio: false }} />
              </div>

              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Batch Size vs Accuracy</h3>
                <div className="h-52">
                  <Bar
                    data={{
                      labels: [16, 32, 64, 128].map(String),
                      datasets: [{
                        label: 'Avg Accuracy (%)',
                        data: [16, 32, 64, 128].map(bs => {
                          const exps = completed.filter(e => e.hyperparameters.batch_size === bs);
                          if (!exps.length) return 0;
                          return +(exps.reduce((s, e) => s + (e.finalMetrics.accuracy ?? 0), 0) / exps.length * 100).toFixed(1);
                        }),
                        backgroundColor: CHART_COLORS,
                        borderRadius: 4,
                      }],
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      scales: { y: { title: { display: true, text: 'Accuracy (%)' }, min: 0, max: 100, beginAtZero: false } },
                      plugins: { legend: { display: false }, title: { display: true, text: 'Batch Size vs Average Accuracy' } },
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Leaderboard ── */}
          {activeTab === 'leaderboard' && (
            <div className="space-y-4">
              {/* Filters */}
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-500 mr-2">Sort by</label>
                  <select
                    value={sortKey}
                    onChange={e => setSortKey(e.target.value as SortKey)}
                    className="text-sm rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  >
                    <option value="accuracy">Best Accuracy</option>
                    <option value="loss">Best Loss</option>
                    <option value="duration">Duration</option>
                    <option value="created">Most Recent</option>
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

              <div className="overflow-x-auto rounded-lg ring-1 ring-gray-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase w-8">#</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Experiment</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Accuracy</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Loss</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">LR</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">BS</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {displayExperiments.map((exp, rank) => (
                      <tr key={exp.id} className={`hover:bg-gray-50 ${rank === 0 ? 'bg-indigo-50/40' : ''}`}>
                        <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                          {rank === 0 ? '🏆' : rank + 1}
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
                          {exp.finalMetrics.accuracy ? `${(exp.finalMetrics.accuracy * 100).toFixed(1)}%` : '—'}
                        </td>
                        <td className="px-4 py-3 text-center font-mono text-gray-700">
                          {exp.finalMetrics.loss ? exp.finalMetrics.loss.toFixed(4) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center font-mono text-xs text-gray-600">
                          {exp.hyperparameters.learning_rate ? (exp.hyperparameters.learning_rate as number).toExponential(1) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center text-gray-600">
                          {exp.hyperparameters.batch_size ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-center text-gray-500 text-xs">
                          {exp.completedAt > 0 ? fmtDur(exp.completedAt - exp.startedAt) : exp.status === 'running' ? 'in progress' : '—'}
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
    </div>
  );
}

export default AnalyticsDashboard;
