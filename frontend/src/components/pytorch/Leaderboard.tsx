/**
 * Leaderboard — sortable table of all runs with their final metric values.
 *
 * Columns: run name, namespace, status, duration, best/last scalar values.
 * Click column headers to sort. Filter by namespace and status.
 * Click a row to open the job detail page.
 */

import React, { useState, useEffect, useMemo } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Job {
  job_id: string;
  job_name?: string;
  namespace?: string;
  status: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  args?: string[] | string;
  script?: string;
}

interface TagSummary {
  tag: string;
  last_value: number;
  min_value: number;
  max_value: number;
  count: number;
}

interface JobMetaSummary {
  jobId: string;
  jobName: string;
  namespace: string;
  status: string;
  script: string;
  duration: string;
  createdAt: string;
  tags: TagSummary[];
  tagMap: Record<string, TagSummary>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function duration(start?: string, end?: string): string {
  if (!start) return '—';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  if (isNaN(s) || isNaN(e)) return '—';
  const d = e - s;
  const m = Math.floor(d / 60000);
  const sec = Math.floor((d % 60000) / 1000);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatDate(ts?: string): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type SortDir = 'asc' | 'desc';

// ── Component ─────────────────────────────────────────────────────────────────

export function Leaderboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [metaSummaries, setMetaSummaries] = useState<JobMetaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterNs, setFilterNs] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Sort
  const [sortCol, setSortCol] = useState<string>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // ── Load jobs ──────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const resp = await fetch('/api/jobs?limit=200');
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        const jobList: Job[] = data.jobs ?? [];
        if (cancelled) return;
        setJobs(jobList);

        // Fetch tag summaries for each job in parallel (limit to 50)
        const slice = jobList.slice(0, 50);
        const summaryResults = await Promise.allSettled(
          slice.map(j => fetch(`/api/jobs/${j.job_id}/metrics/tags`).then(r => r.json()))
        );

        if (cancelled) return;
        const metas: JobMetaSummary[] = slice.map((job, i) => {
          const result = summaryResults[i];
          const tags: TagSummary[] = result.status === 'fulfilled' ? (result.value.tags ?? []) : [];
          const tagMap: Record<string, TagSummary> = {};
          tags.forEach(t => { tagMap[t.tag] = t; });
          return {
            jobId: job.job_id,
            jobName: job.job_name || job.job_id.slice(0, 8),
            namespace: job.namespace ?? 'default',
            status: job.status,
            script: job.script ?? '—',
            duration: duration(job.started_at, job.completed_at),
            createdAt: job.created_at,
            tags,
            tagMap,
          };
        });
        setMetaSummaries(metas);
      } catch (e: any) {
        setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // ── All metric columns (union across loaded jobs) ─────────────────────────

  const metricCols = useMemo(() => {
    const set = new Set<string>();
    metaSummaries.forEach(m => m.tags.forEach(t => set.add(t.tag)));
    return Array.from(set).sort();
  }, [metaSummaries]);

  // ── Filter + sort ──────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return metaSummaries.filter(m => {
      if (filterNs && m.namespace !== filterNs) return false;
      if (filterStatus && m.status !== filterStatus) return false;
      return true;
    });
  }, [metaSummaries, filterNs, filterStatus]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: any, bv: any;
      if (sortCol === 'createdAt') {
        av = new Date(a.createdAt).getTime();
        bv = new Date(b.createdAt).getTime();
      } else if (sortCol === 'jobName') {
        av = a.jobName; bv = b.jobName;
      } else if (sortCol === 'status') {
        av = a.status; bv = b.status;
      } else if (sortCol === 'namespace') {
        av = a.namespace; bv = b.namespace;
      } else {
        // metric column
        const isLoss = sortCol.includes('loss') || sortCol.includes('err');
        av = a.tagMap[sortCol]?.last_value ?? (isLoss ? Infinity : -Infinity);
        bv = b.tagMap[sortCol]?.last_value ?? (isLoss ? Infinity : -Infinity);
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filtered, sortCol, sortDir]);

  const toggleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const SortIcon = ({ col }: { col: string }) => {
    if (sortCol !== col) return <span className="text-gray-300 ml-1">↕</span>;
    return <span className="text-indigo-500 ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  // Unique namespaces + statuses for filter dropdowns
  const namespaces = useMemo(() => Array.from(new Set(metaSummaries.map(m => m.namespace))).sort(), [metaSummaries]);
  const statuses = useMemo(() => Array.from(new Set(metaSummaries.map(m => m.status))).sort(), [metaSummaries]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="text-sm text-gray-400 text-center py-8">Loading leaderboard…</div>;
  }

  if (error) {
    return <div className="bg-red-50 border border-red-200 rounded-md p-4 text-sm text-red-800">{error}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <select
          value={filterNs}
          onChange={e => setFilterNs(e.target.value)}
          className="text-sm border border-gray-200 rounded-md px-2 py-1 text-gray-700 bg-white"
        >
          <option value="">All namespaces</option>
          {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="text-sm border border-gray-200 rounded-md px-2 py-1 text-gray-700 bg-white"
        >
          <option value="">All statuses</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-xs text-gray-400 ml-auto">{sorted.length} runs</span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100 text-xs">
            <thead className="bg-gray-50">
              <tr>
                {[
                  { key: 'jobName', label: 'Run' },
                  { key: 'namespace', label: 'Namespace' },
                  { key: 'status', label: 'Status' },
                  { key: 'createdAt', label: 'Created' },
                ].map(col => (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className="px-4 py-2.5 text-left font-medium text-gray-500 cursor-pointer select-none hover:text-gray-700 whitespace-nowrap"
                  >
                    {col.label}<SortIcon col={col.key} />
                  </th>
                ))}
                <th className="px-3 py-2.5 text-left font-medium text-gray-500">Duration</th>
                {metricCols.map(tag => (
                  <th
                    key={tag}
                    onClick={() => toggleSort(tag)}
                    className="px-3 py-2.5 text-right font-medium text-gray-500 cursor-pointer select-none hover:text-gray-700 whitespace-nowrap"
                  >
                    {tag}<SortIcon col={tag} />
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right font-medium text-gray-500">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={5 + metricCols.length + 1} className="px-4 py-8 text-center text-gray-400">
                    No runs found.
                  </td>
                </tr>
              ) : sorted.map(row => (
                <tr key={row.jobId} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900 whitespace-nowrap">
                    <span className="truncate max-w-[160px] block">{row.jobName}</span>
                    <span className="text-gray-400 font-mono">{row.jobId.slice(0, 8)}</span>
                  </td>
                  <td className="px-3 py-2 text-gray-500">{row.namespace}</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      row.status === 'completed' ? 'bg-green-100 text-green-700' :
                      row.status === 'running'   ? 'bg-blue-100 text-blue-700' :
                      row.status === 'queued'    ? 'bg-yellow-100 text-yellow-700' :
                      row.status === 'failed'    ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>{row.status}</span>
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{formatDate(row.createdAt)}</td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{row.duration}</td>
                  {metricCols.map(tag => {
                    const s = row.tagMap[tag];
                    return (
                      <td key={tag} className="px-3 py-2 text-right font-mono">
                        {s ? (
                          <span className="text-gray-900">{s.last_value.toFixed(4)}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right">
                    <a
                      href={`/experiments/job/${row.jobId}`}
                      className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                    >
                      View
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default Leaderboard;
