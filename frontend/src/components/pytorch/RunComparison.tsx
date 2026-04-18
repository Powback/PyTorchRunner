/**
 * RunComparison — overlay loss curves from multiple jobs on the same chart.
 *
 * Lets users pick any combination of completed/running jobs and compare their
 * metric histories side-by-side with colour-coded lines.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

// ── Types ─────────────────────────────────────────────────────────────────────

interface Job {
  job_id: string;
  job_name?: string;
  namespace?: string;
  status: string;
  created_at: string;
  args?: string[] | string;
}

interface ScalarPoint {
  step: number;
  value: number;
  wall_time: number;
}

interface RunData {
  job: Job;
  scalars: Record<string, ScalarPoint[]>;
  tags: string[];
}

// ── Palette ────────────────────────────────────────────────────────────────

const PALETTE = [
  'rgb(239, 68, 68)',
  'rgb(59, 130, 246)',
  'rgb(34, 197, 94)',
  'rgb(245, 158, 11)',
  'rgb(168, 85, 247)',
  'rgb(20, 184, 166)',
  'rgb(249, 115, 22)',
  'rgb(236, 72, 153)',
  'rgb(99, 102, 241)',
  'rgb(16, 185, 129)',
];

function rgba(hex: string, alpha: number) {
  return hex.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
}

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

export function RunComparison() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [runData, setRunData] = useState<Map<string, RunData>>(new Map());
  const [activeTag, setActiveTag] = useState<string>('loss');
  const [smoothing, setSmoothing] = useState(0.6);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // ── Load job list ──────────────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/jobs?limit=100')
      .then(r => r.json())
      .then(data => {
        setJobs((data.jobs ?? []).filter((j: Job) => ['completed', 'running', 'failed'].includes(j.status)));
        setLoadingJobs(false);
      })
      .catch(e => { setError(e.message); setLoadingJobs(false); });
  }, []);

  // ── Toggle run selection ───────────────────────────────────────────────────

  const toggleRun = useCallback(async (jobId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(jobId)) { next.delete(jobId); return next; }
      next.add(jobId);
      return next;
    });

    if (runData.has(jobId)) return; // already loaded

    setLoadingRuns(prev => new Set([...prev, jobId]));
    try {
      const [metricsResp, tagsResp] = await Promise.all([
        fetch(`/api/jobs/${jobId}/metrics`),
        fetch(`/api/jobs/${jobId}/metrics/tags`),
      ]);
      const [metricsData, tagsData] = await Promise.all([metricsResp.json(), tagsResp.json()]);
      const job = jobs.find(j => j.job_id === jobId)!;
      setRunData(prev => new Map(prev).set(jobId, {
        job,
        scalars: metricsData.scalars ?? {},
        tags: (tagsData.tags ?? []).map((t: any) => t.tag),
      }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingRuns(prev => { const s = new Set(prev); s.delete(jobId); return s; });
    }
  }, [jobs, runData]);

  // ── All available tags across selected runs ────────────────────────────────

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const [id, data] of runData) {
      if (selectedIds.has(id)) data.tags.forEach(t => set.add(t));
    }
    return Array.from(set).sort();
  }, [runData, selectedIds]);

  useEffect(() => {
    if (allTags.length > 0 && !allTags.includes(activeTag)) {
      setActiveTag(allTags[0]);
    }
  }, [allTags, activeTag]);

  // ── Chart data ─────────────────────────────────────────────────────────────

  const chartData = useMemo(() => {
    const datasets: any[] = [];
    let colorIdx = 0;
    for (const [jobId, data] of runData) {
      if (!selectedIds.has(jobId)) { colorIdx++; continue; }
      const pts = data.scalars[activeTag] ?? [];
      if (pts.length === 0) { colorIdx++; continue; }

      const raw = pts.map(p => p.value);
      const smoothed = ema(raw, smoothing);
      const color = PALETTE[colorIdx % PALETTE.length];
      const label = data.job.job_name || jobId.slice(0, 8);

      datasets.push({
        label,
        data: pts.map((p, i) => ({ x: p.step, y: smoothed[i] })),
        borderColor: color,
        backgroundColor: rgba(color, 0.05),
        borderWidth: 1.5,
        pointRadius: pts.length > 200 ? 0 : 2,
        tension: 0.2,
        fill: false,
      });
      colorIdx++;
    }
    return { datasets };
  }, [runData, selectedIds, activeTag, smoothing]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    interaction: { intersect: false, mode: 'index' as const },
    scales: {
      x: { type: 'linear' as const, title: { display: true, text: 'Step' } },
      y: { title: { display: true, text: activeTag }, beginAtZero: false },
    },
    plugins: {
      legend: { position: 'top' as const },
      tooltip: {
        callbacks: {
          title: (items: any[]) => `Step ${items[0]?.parsed?.x}`,
        },
      },
    },
  }), [activeTag]);

  // ── Final metrics summary table ────────────────────────────────────────────

  const summaryRows = useMemo(() => {
    return Array.from(selectedIds).map(jobId => {
      const data = runData.get(jobId);
      if (!data) return null;
      const jobLabel = data.job.job_name || jobId.slice(0, 8);
      const tagSummaries: Record<string, { last: number; best: number }> = {};
      for (const tag of data.tags) {
        const pts = data.scalars[tag] ?? [];
        if (pts.length === 0) continue;
        const vals = pts.map(p => p.value);
        const last = vals[vals.length - 1];
        const isLoss = tag.includes('loss') || tag.includes('err');
        const best = isLoss ? Math.min(...vals) : Math.max(...vals);
        tagSummaries[tag] = { last, best };
      }
      return { jobId, jobLabel, status: data.job.status, namespace: data.job.namespace ?? '—', tagSummaries };
    }).filter(Boolean);
  }, [selectedIds, runData]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-800">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Job selector */}
        <div className="bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Select Runs</h3>
          {loadingJobs ? (
            <p className="text-sm text-gray-400">Loading jobs…</p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-gray-400">No completed jobs found.</p>
          ) : (
            <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
              {jobs.map(job => {
                const isSelected = selectedIds.has(job.job_id);
                const isLoading = loadingRuns.has(job.job_id);
                return (
                  <button
                    key={job.job_id}
                    onClick={() => toggleRun(job.job_id)}
                    disabled={isLoading}
                    className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors ${
                      isSelected
                        ? 'bg-indigo-50 ring-1 ring-indigo-300 text-indigo-900'
                        : 'hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">
                        {job.job_name || job.job_id.slice(0, 8)}
                      </span>
                      <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        job.status === 'completed' ? 'bg-green-100 text-green-700' :
                        job.status === 'running'   ? 'bg-blue-100 text-blue-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {isLoading ? '…' : job.status}
                      </span>
                    </div>
                    <div className="text-gray-400 mt-0.5 truncate">{job.namespace ?? 'default'}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Chart */}
        <div className="lg:col-span-2 bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm p-4 space-y-3">
          {/* Tag selector + smoothing */}
          <div className="flex flex-wrap items-center gap-3">
            {allTags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {allTags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => setActiveTag(tag)}
                    className={`px-2 py-0.5 rounded text-xs font-medium border ${
                      activeTag === tag
                        ? 'bg-indigo-600 text-white border-transparent'
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 text-xs text-gray-500 ml-auto">
              <span>Smooth</span>
              <input
                type="range" min="0" max="0.99" step="0.01"
                value={smoothing}
                onChange={e => setSmoothing(parseFloat(e.target.value))}
                className="w-16 accent-indigo-600"
              />
              <span>{(smoothing * 100).toFixed(0)}%</span>
            </div>
          </div>

          {selectedIds.size === 0 ? (
            <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
              Select runs from the left panel to compare them.
            </div>
          ) : (
            <div style={{ height: 280 }}>
              <Line data={chartData} options={chartOptions} />
            </div>
          )}
        </div>
      </div>

      {/* Summary table */}
      {summaryRows.length > 0 && (
        <div className="bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Final Metric Values</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100 text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">Run</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Namespace</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-500">Status</th>
                  {allTags.map(tag => (
                    <th key={tag} className="px-3 py-2 text-right font-medium text-gray-500">{tag}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {summaryRows.map(row => row && (
                  <tr key={row.jobId} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-900">
                      <a href={`/experiments/job/${row.jobId}`} className="text-indigo-600 hover:underline">
                        {row.jobLabel}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{row.namespace}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        row.status === 'completed' ? 'bg-green-100 text-green-700' :
                        row.status === 'running'   ? 'bg-blue-100 text-blue-700' :
                        'bg-red-100 text-red-700'
                      }`}>{row.status}</span>
                    </td>
                    {allTags.map(tag => {
                      const s = row.tagSummaries[tag];
                      return (
                        <td key={tag} className="px-3 py-2 text-right font-mono text-gray-700">
                          {s ? s.last.toFixed(4) : '—'}
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
    </div>
  );
}

export default RunComparison;
