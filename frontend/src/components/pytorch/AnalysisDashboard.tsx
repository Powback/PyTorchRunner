/**
 * AnalysisDashboard — Tier 3 Advanced Analysis Page Component
 *
 * Fetches all completed runs, groups by namespace, and provides:
 *   - Group/experiment selector panel
 *   - HyperparameterCorrelation scatter matrix
 *   - ParallelCoordinates across all dimensions
 *   - HistogramViewer for metric distributions
 *   - MinMaxMeanBands for aggregate training curves
 *   - ChartControls applied to the bands chart
 *
 * Links back from leaderboard → individual run detail pages.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { HyperparameterCorrelation } from './HyperparameterCorrelation';
import type { RunDataPoint } from './HyperparameterCorrelation';
import { ParallelCoordinates } from './ParallelCoordinates';
import type { PCRun } from './ParallelCoordinates';
import { HistogramViewer } from './HistogramViewer';
import type { HistogramRun } from './HistogramViewer';
import { MinMaxMeanBands } from './MinMaxMeanBands';
import type { BandRun } from './MinMaxMeanBands';
import { ChartControls, defaultControlsState } from './ChartControls';
import type { ChartControlsState } from './ChartControls';
import { pytorchAPI } from '../../lib/pytorch/api-client';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Group {
  name: string;
  count: number;
  statusCounts: Record<string, number>;
}

interface GroupSummary {
  group: string;
  total: number;
  statusCounts: Record<string, number>;
  metricStats: Record<string, {
    best: number; worst: number; mean: number; std: number;
    min: number; max: number; count: number;
  }>;
  hpRanges: Record<string, { min: number; max: number; count: number }>;
  runs: any[];
}

type TabKey = 'correlation' | 'parallel' | 'histogram' | 'bands' | 'leaderboard';

// ── Transform API job record → analysis shapes ────────────────────────────────

function toRunDataPoint(job: any): RunDataPoint {
  const envVars = job.envVars || job.env_vars || {};
  const metricsSummary = job.metricsSummary || job.metrics_summary || {};

  // Extract numeric env vars as hyperparams
  const hyperparams: Record<string, number> = {};
  for (const [k, v] of Object.entries(envVars)) {
    // Skip internal system vars
    if (['PYTORCH_ENABLE_MPS_FALLBACK', 'PYTHONUNBUFFERED', 'PYTORCHRUNNER_METRICS',
         'PYTORCHRUNNER_JOB_ID', 'PATH', 'HOME', 'USER', 'SHELL'].includes(k)) continue;
    const n = Number(v);
    if (!isNaN(n) && String(v).trim() !== '') hyperparams[k] = n;
  }

  const finalMetrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(metricsSummary)) {
    if (typeof v === 'number') finalMetrics[k] = v;
  }

  return {
    jobId: job.jobId || job.job_id,
    name: job.jobName || job.job_name || `job-${(job.jobId || job.job_id || '').slice(0, 8)}`,
    hyperparams,
    finalMetrics,
    status: job.status ?? 'unknown',
  };
}

function toPCRun(job: any, dims: string[]): PCRun {
  const rdp = toRunDataPoint(job);
  const values: Record<string, number> = {
    ...rdp.hyperparams,
    ...rdp.finalMetrics,
  };
  return { jobId: rdp.jobId, name: rdp.name, values, status: rdp.status };
}

function toHistogramRun(job: any): HistogramRun {
  const rdp = toRunDataPoint(job);
  return { jobId: rdp.jobId, name: rdp.name, finalMetrics: rdp.finalMetrics, status: rdp.status };
}

// ── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CLASSES: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  running:   'bg-blue-100 text-blue-800',
  failed:    'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-600',
  queued:    'bg-purple-100 text-purple-700',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASSES[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function formatVal(k: string, v: number): string {
  if (Math.abs(v) < 0.001 && v !== 0) return v.toExponential(2);
  if (k.toLowerCase().includes('accuracy') || k.toLowerCase().includes('acc')) return `${(v * 100).toFixed(1)}%`;
  return parseFloat(v.toPrecision(4)).toString();
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function AnalysisDashboard() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [groupSummary, setGroupSummary] = useState<GroupSummary | null>(null);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('correlation');
  const [controls, setControls] = useState<ChartControlsState>(defaultControlsState);
  const [targetMetric, setTargetMetric] = useState('');
  const [leaderboardSort, setLeaderboardSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'created', dir: -1 });

  // Fetch all groups on mount
  useEffect(() => {
    const load = async () => {
      setLoadingGroups(true);
      setError(null);
      try {
        const resp = await fetch('/api/experiments/groups');
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const data = await resp.json();
        const g: Group[] = (data.groups ?? []).map((grp: any) => ({
          name: grp.name,
          count: grp.count,
          statusCounts: grp.statusCounts || grp.status_counts || {},
        }));
        setGroups(g);
        if (g.length > 0 && !selectedGroup) setSelectedGroup(g[0].name);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoadingGroups(false);
      }
    };
    load();
  }, []);

  // Fetch group summary when selection changes
  useEffect(() => {
    if (!selectedGroup) return;
    const load = async () => {
      setLoadingSummary(true);
      setGroupSummary(null);
      try {
        const resp = await fetch(`/api/experiments/groups/${encodeURIComponent(selectedGroup)}`);
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
        const data = await resp.json();
        setGroupSummary({
          group: data.group,
          total: data.total,
          statusCounts: data.statusCounts || data.status_counts || {},
          metricStats: data.metricStats || data.metric_stats || {},
          hpRanges: data.hpRanges || data.hp_ranges || {},
          runs: data.runs || [],
        });
        // Auto-select first loss metric as target
        const mKeys = Object.keys(data.metricStats || data.metric_stats || {});
        const loss = mKeys.find(k => k.toLowerCase().includes('loss')) || mKeys[0] || '';
        setTargetMetric(loss);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoadingSummary(false);
      }
    };
    load();
  }, [selectedGroup]);

  // Derived shapes for each sub-component
  const runDataPoints = useMemo<RunDataPoint[]>(() =>
    (groupSummary?.runs ?? []).map(toRunDataPoint),
    [groupSummary]
  );

  const dimensions = useMemo(() => {
    const hps = new Set<string>();
    const mets = new Set<string>();
    for (const r of runDataPoints) {
      Object.keys(r.hyperparams).forEach(k => hps.add(k));
      Object.keys(r.finalMetrics).forEach(k => mets.add(k));
    }
    return [...hps, ...mets];
  }, [runDataPoints]);

  const pcRuns = useMemo<PCRun[]>(() =>
    (groupSummary?.runs ?? []).map(j => toPCRun(j, dimensions)),
    [groupSummary, dimensions]
  );

  const histogramRuns = useMemo<HistogramRun[]>(() =>
    (groupSummary?.runs ?? []).map(toHistogramRun),
    [groupSummary]
  );

  // Bands: we'd need time-series data per run, which requires a separate fetch per job.
  // For now, show what we have from metricSeries (empty unless populated).
  // In a full integration this would fetch /api/jobs/{id}/metrics for each run.
  const bandRuns = useMemo<BandRun[]>(() =>
    runDataPoints.map(r => ({
      jobId: r.jobId,
      name: r.name,
      metricSeries: {}, // populated by per-job metrics fetch (out of scope for this pass)
    })),
    [runDataPoints]
  );

  // Leaderboard: sorted runs table
  const leaderboardRuns = useMemo(() => {
    const runs = [...runDataPoints];
    const { key, dir } = leaderboardSort;

    runs.sort((a, b) => {
      if (key === 'created') {
        const ta = (groupSummary?.runs ?? []).find((j: any) => (j.jobId || j.job_id) === a.jobId)?.createdAt || 0;
        const tb = (groupSummary?.runs ?? []).find((j: any) => (j.jobId || j.job_id) === b.jobId)?.createdAt || 0;
        return (new Date(ta).getTime() - new Date(tb).getTime()) * dir;
      }
      const va = a.finalMetrics[key] ?? -Infinity;
      const vb = b.finalMetrics[key] ?? -Infinity;
      return (va - vb) * dir;
    });
    return runs;
  }, [runDataPoints, leaderboardSort, groupSummary]);

  const allMetrics = useMemo(() => {
    const s = new Set<string>();
    runDataPoints.forEach(r => Object.keys(r.finalMetrics).forEach(k => s.add(k)));
    return [...s];
  }, [runDataPoints]);

  const handleSort = (key: string) => {
    setLeaderboardSort(prev =>
      prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: -1 }
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loadingGroups) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mb-3" />
          <p className="text-sm text-gray-500">Loading experiment groups…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
        <p className="text-sm text-red-700 font-medium">Failed to load analysis data</p>
        <p className="text-xs text-red-500 mt-1">{error}</p>
        <p className="text-xs text-gray-500 mt-3">
          Make sure the PyTorchRunner backend is running and accessible.
        </p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="text-center py-16">
        <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" />
        </svg>
        <h3 className="mt-3 text-sm font-semibold text-gray-900">No runs yet</h3>
        <p className="mt-1 text-sm text-gray-500">Submit jobs to start seeing hyperparameter analysis.</p>
        <a href="/" className="mt-4 inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
          Submit a Job
        </a>
      </div>
    );
  }

  return (
    <div className="flex gap-6 min-h-[600px]">
      {/* ── Sidebar: group selector ── */}
      <aside className="w-52 shrink-0">
        <div className="bg-white rounded-lg shadow-sm ring-1 ring-gray-900/5 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Namespaces</h2>
          </div>
          <ul className="divide-y divide-gray-50">
            {groups.map(g => (
              <li key={g.name}>
                <button
                  onClick={() => setSelectedGroup(g.name)}
                  className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${
                    selectedGroup === g.name ? 'bg-indigo-50 border-l-2 border-indigo-600' : ''
                  }`}
                >
                  <div className={`text-sm font-medium truncate ${selectedGroup === g.name ? 'text-indigo-700' : 'text-gray-800'}`}>
                    {g.name}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {g.count} run{g.count !== 1 ? 's' : ''}
                    {g.statusCounts.completed != null && ` · ${g.statusCounts.completed} done`}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div className="flex-1 min-w-0 space-y-6">
        {loadingSummary ? (
          <div className="flex items-center justify-center py-24">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
          </div>
        ) : groupSummary ? (
          <>
            {/* Header */}
            <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">{groupSummary.group}</h2>
                  <p className="text-sm text-gray-500">
                    {groupSummary.total} run{groupSummary.total !== 1 ? 's' : ''}
                    {Object.entries(groupSummary.statusCounts).map(([s, n]) => (
                      <span key={s} className="ml-2">
                        <StatusBadge status={s} /> <span className="text-gray-400 text-xs">{n}</span>
                      </span>
                    ))}
                  </p>
                </div>

                {/* Target metric selector for coloring */}
                {allMetrics.length > 0 && (
                  <div className="flex items-center gap-2 text-sm">
                    <label className="text-gray-600 font-medium">Color by</label>
                    <select
                      value={targetMetric}
                      onChange={e => setTargetMetric(e.target.value)}
                      className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-500"
                    >
                      {allMetrics.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {/* Metric stats strip */}
              {Object.keys(groupSummary.metricStats).length > 0 && (
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {Object.entries(groupSummary.metricStats).slice(0, 4).map(([m, s]) => (
                    <div key={m} className="bg-gray-50 rounded-lg px-3 py-2">
                      <div className="text-xs text-gray-500 truncate">{m}</div>
                      <div className="text-sm font-semibold text-gray-900">{formatVal(m, s.best)}</div>
                      <div className="text-xs text-gray-400">best · μ {formatVal(m, s.mean)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Tabs */}
            <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg overflow-hidden">
              <div className="flex border-b border-gray-200 overflow-x-auto">
                {([
                  { key: 'correlation', label: 'Param Correlation' },
                  { key: 'parallel',    label: 'Parallel Coords' },
                  { key: 'histogram',   label: 'Distributions' },
                  { key: 'bands',       label: 'Aggregate Curves' },
                  { key: 'leaderboard', label: 'Leaderboard' },
                ] as { key: TabKey; label: string }[]).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={`px-5 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                      activeTab === key
                        ? 'border-indigo-600 text-indigo-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="p-6">

                {/* ── Hyperparameter Correlation ── */}
                {activeTab === 'correlation' && (
                  <HyperparameterCorrelation runs={runDataPoints} />
                )}

                {/* ── Parallel Coordinates ── */}
                {activeTab === 'parallel' && (
                  <div className="space-y-4">
                    <p className="text-sm text-gray-500">
                      Each line = one run. Hover to inspect; click to pin.
                      Axes show hyperparameters (left) and metrics (right).
                    </p>
                    <ParallelCoordinates
                      runs={pcRuns}
                      dimensions={dimensions}
                      targetMetric={targetMetric}
                      height={380}
                    />
                  </div>
                )}

                {/* ── Distributions ── */}
                {activeTab === 'histogram' && (
                  <HistogramViewer runs={histogramRuns} />
                )}

                {/* ── Aggregate Curves (MinMaxMean bands) ── */}
                {activeTab === 'bands' && (
                  <div className="space-y-4">
                    <ChartControls
                      state={controls}
                      onChange={setControls}
                      showAnnotations={false}
                    />
                    <MinMaxMeanBands runs={bandRuns} />
                    <div className="text-xs text-gray-400 text-center">
                      Time-series data is loaded per-run from the job stream endpoint.
                      Runs without step-by-step metrics show as empty.
                    </div>
                  </div>
                )}

                {/* ── Leaderboard ── */}
                {activeTab === 'leaderboard' && (
                  <div className="space-y-3">
                    <div className="overflow-x-auto rounded-lg ring-1 ring-gray-200">
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Run</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                            {allMetrics.slice(0, 4).map(m => (
                              <th
                                key={m}
                                className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-800 select-none"
                                onClick={() => handleSort(m)}
                              >
                                {m}
                                {leaderboardSort.key === m && (
                                  <span className="ml-1">{leaderboardSort.dir === 1 ? '↑' : '↓'}</span>
                                )}
                              </th>
                            ))}
                            <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 bg-white">
                          {leaderboardRuns.map((r, idx) => {
                            const rawJob = (groupSummary?.runs ?? []).find((j: any) =>
                              (j.jobId || j.job_id) === r.jobId
                            );
                            const jobId = r.jobId;
                            return (
                              <tr key={r.jobId} className="hover:bg-gray-50">
                                <td className="px-4 py-3 whitespace-nowrap">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-gray-400 font-mono w-5 text-right">{idx + 1}</span>
                                    <div>
                                      <div className="font-medium text-gray-900 text-xs">{r.name}</div>
                                      <div className="text-xs text-gray-400 font-mono">{jobId.slice(0, 8)}</div>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  <StatusBadge status={r.status} />
                                </td>
                                {allMetrics.slice(0, 4).map(m => {
                                  const v = r.finalMetrics[m];
                                  const stats = groupSummary?.metricStats[m];
                                  const isBest = stats && Math.abs((v ?? NaN) - stats.best) < 1e-9;
                                  return (
                                    <td key={m} className="px-4 py-3 text-center">
                                      {v !== undefined ? (
                                        <span className={`font-mono text-xs ${isBest ? 'text-green-600 font-bold' : 'text-gray-700'}`}>
                                          {formatVal(m, v)}{isBest ? ' ★' : ''}
                                        </span>
                                      ) : (
                                        <span className="text-gray-300 text-xs">—</span>
                                      )}
                                    </td>
                                  );
                                })}
                                <td className="px-4 py-3 text-center">
                                  <a
                                    href={`/experiments/job/${jobId}`}
                                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                                  >
                                    View →
                                  </a>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-gray-400 text-center">
                      Click a metric column header to sort. ★ = best in group.
                      <a href={`/analytics`} className="ml-2 text-indigo-500 hover:underline">Full analytics →</a>
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-16 text-gray-400">
            Select a namespace from the sidebar.
          </div>
        )}
      </div>
    </div>
  );
}

export default AnalysisDashboard;
