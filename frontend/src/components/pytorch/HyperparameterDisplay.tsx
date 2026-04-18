/**
 * HyperparameterDisplay — shows job config/args as key-value pairs
 * and optionally compares hyperparameters across multiple selected runs.
 */

import React, { useState, useEffect, useMemo } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Job {
  job_id: string;
  job_name?: string;
  namespace?: string;
  script?: string;
  args?: string[] | string;
  env_vars?: Record<string, string>;
  tags?: string[] | string;
  created_at?: string;
}

interface HyperparameterDisplayProps {
  /** Show a single job's config when jobId is provided */
  jobId?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(args: string[] | string | undefined): Record<string, string> {
  if (!args) return {};
  const arr = typeof args === 'string' ? JSON.parse(args) as string[] : args;
  const out: Record<string, string> = {};
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = arr[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

function diffHighlight(a: string, b: string): boolean {
  return a !== b;
}

// ── Single-job view ───────────────────────────────────────────────────────────

function SingleJobConfig({ job }: { job: Job }) {
  const params = useMemo(() => parseArgs(job.args), [job.args]);
  const envVars = job.env_vars ?? {};
  const hasParams = Object.keys(params).length > 0;
  const hasEnv = Object.keys(envVars).length > 0;

  return (
    <div className="space-y-4">
      {/* Run info */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        {[
          { label: 'Script',    value: job.script ?? '—' },
          { label: 'Namespace', value: job.namespace ?? 'default' },
          { label: 'Job Name',  value: job.job_name ?? '—' },
          { label: 'Created',   value: job.created_at ? new Date(job.created_at).toLocaleString() : '—' },
        ].map(({ label, value }) => (
          <div key={label}>
            <dt className="text-gray-500">{label}</dt>
            <dd className="text-gray-900 font-medium font-mono truncate">{value}</dd>
          </div>
        ))}
      </div>

      {/* CLI args */}
      {hasParams && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">CLI Arguments</h4>
          <div className="bg-gray-50 rounded-md divide-y divide-gray-100">
            {Object.entries(params).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between px-3 py-1.5 text-xs">
                <span className="text-gray-600 font-mono">{k}</span>
                <span className="text-gray-900 font-mono">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Env vars (filter out system-level ones) */}
      {hasEnv && (
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Environment</h4>
          <div className="bg-gray-50 rounded-md divide-y divide-gray-100">
            {Object.entries(envVars)
              .filter(([k]) => !['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM'].includes(k))
              .map(([k, v]) => (
                <div key={k} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="text-gray-600 font-mono">{k}</span>
                  <span className="text-gray-900 font-mono truncate max-w-[200px]">{v}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {!hasParams && !hasEnv && (
        <p className="text-sm text-gray-400 text-center py-4">No hyperparameters recorded.</p>
      )}
    </div>
  );
}

// ── Comparison view ───────────────────────────────────────────────────────────

function ComparisonTable({ jobs }: { jobs: Job[] }) {
  const allParams = useMemo(() => {
    const keys = new Set<string>();
    jobs.forEach(j => Object.keys(parseArgs(j.args)).forEach(k => keys.add(k)));
    return Array.from(keys).sort();
  }, [jobs]);

  const jobParams = useMemo(() =>
    jobs.map(j => ({ id: j.job_id, name: j.job_name || j.job_id.slice(0, 8), params: parseArgs(j.args) })),
  [jobs]);

  if (allParams.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-4">No CLI args to compare.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs divide-y divide-gray-100">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2 text-left font-medium text-gray-500 whitespace-nowrap">Parameter</th>
            {jobParams.map(jp => (
              <th key={jp.id} className="px-3 py-2 text-right font-medium text-gray-700 whitespace-nowrap">
                <a href={`/experiments/job/${jp.id}`} className="text-indigo-600 hover:underline">{jp.name}</a>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {allParams.map(key => {
            const vals = jobParams.map(jp => jp.params[key] ?? '—');
            const allSame = vals.every(v => v === vals[0]);
            return (
              <tr key={key} className={allSame ? '' : 'bg-amber-50/50'}>
                <td className="px-4 py-1.5 font-mono text-gray-600">{key}</td>
                {vals.map((v, i) => (
                  <td
                    key={i}
                    className={`px-3 py-1.5 text-right font-mono ${
                      !allSame && v !== vals[0] ? 'text-amber-700 font-semibold' : 'text-gray-900'
                    }`}
                  >
                    {v}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!allParams.every(k => jobs.every(j => parseArgs(j.args)[k] === parseArgs(jobs[0].args)[k])) && (
        <p className="text-[10px] text-amber-600 px-4 py-2">Highlighted rows differ between runs.</p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function HyperparameterDisplay({ jobId }: HyperparameterDisplayProps) {
  const [mode, setMode] = useState<'single' | 'compare'>(jobId ? 'single' : 'compare');
  const [singleJob, setSingleJob] = useState<Job | null>(null);
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(jobId ? new Set([jobId]) : new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (jobId) {
      fetch(`/api/jobs/${jobId}`)
        .then(r => r.json())
        .then(data => { setSingleJob(data); setLoading(false); })
        .catch(e => { setError(e.message); setLoading(false); });
    } else {
      fetch('/api/jobs?limit=100')
        .then(r => r.json())
        .then(data => {
          setAllJobs(data.jobs ?? []);
          setLoading(false);
        })
        .catch(e => { setError(e.message); setLoading(false); });
    }
  }, [jobId]);

  const selectedJobs = useMemo(
    () => allJobs.filter(j => selectedIds.has(j.job_id)),
    [allJobs, selectedIds]
  );

  const toggleJob = (id: string) => {
    setSelectedIds(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  if (loading) {
    return <div className="text-sm text-gray-400 text-center py-4">Loading…</div>;
  }
  if (error) {
    return <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-800">{error}</div>;
  }

  // Single-job mode (e.g. on job detail page)
  if (jobId && singleJob) {
    return (
      <div className="bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Hyperparameters</h3>
        <SingleJobConfig job={singleJob} />
      </div>
    );
  }

  // Multi-run comparison mode
  return (
    <div className="space-y-4">
      {/* Mode tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['single', 'compare'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              mode === m ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {m === 'single' ? 'Single Run' : 'Compare Runs'}
          </button>
        ))}
      </div>

      {mode === 'compare' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Job picker */}
          <div className="bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm p-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Select Runs</h4>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {allJobs.map(job => (
                <button
                  key={job.job_id}
                  onClick={() => toggleJob(job.job_id)}
                  className={`w-full text-left px-3 py-1.5 rounded text-xs transition-colors ${
                    selectedIds.has(job.job_id)
                      ? 'bg-indigo-50 ring-1 ring-indigo-200 text-indigo-900'
                      : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <div className="font-medium truncate">{job.job_name || job.job_id.slice(0, 8)}</div>
                  <div className="text-gray-400 mt-0.5">{job.namespace ?? 'default'}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Comparison table */}
          <div className="lg:col-span-2 bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm overflow-hidden">
            {selectedJobs.length < 2 ? (
              <div className="flex items-center justify-center h-32 text-sm text-gray-400">
                Select at least 2 runs to compare.
              </div>
            ) : (
              <ComparisonTable jobs={selectedJobs} />
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Pick one job */}
          <div className="bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm p-4">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">Select a Run</h4>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {allJobs.map(job => (
                <button
                  key={job.job_id}
                  onClick={() => setSelectedIds(new Set([job.job_id]))}
                  className={`w-full text-left px-3 py-1.5 rounded text-xs transition-colors ${
                    selectedIds.has(job.job_id) && selectedIds.size === 1
                      ? 'bg-indigo-50 ring-1 ring-indigo-200 text-indigo-900'
                      : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <div className="font-medium truncate">{job.job_name || job.job_id.slice(0, 8)}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="bg-white rounded-lg ring-1 ring-gray-900/5 shadow-sm p-4">
            {selectedJobs.length === 1 ? (
              <SingleJobConfig job={selectedJobs[0]} />
            ) : (
              <div className="flex items-center justify-center h-32 text-sm text-gray-400">
                Select a run from the left.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default HyperparameterDisplay;
