/**
 * ChartControls
 * Reusable set of controls that can be applied to any chart:
 *   - Log scale toggle for Y-axis
 *   - Outlier filtering (remove values beyond N standard deviations)
 *   - Custom X-axis range selection
 *   - Export data as CSV
 *   - Annotation support (mark key points on charts)
 */

import React, { useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChartControlsState {
  logScale: boolean;
  outlierSigma: number | null; // null = disabled
  xMin: number | null;
  xMax: number | null;
  annotations: Annotation[];
}

export interface Annotation {
  id: string;
  x: number;
  label: string;
  color: string;
}

interface ChartControlsProps {
  state: ChartControlsState;
  onChange: (next: ChartControlsState) => void;
  /** Raw data for CSV export: [{name, step, value, ...}] */
  exportData?: Record<string, any>[];
  exportFilename?: string;
  /** Total steps available (for range clamps) */
  totalSteps?: number;
  /** Show/hide individual sections */
  showLogScale?: boolean;
  showOutlierFilter?: boolean;
  showXRange?: boolean;
  showExport?: boolean;
  showAnnotations?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function exportCSV(rows: Record<string, any>[], filename: string) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const lines = [
    cols.join(','),
    ...rows.map(r => cols.map(c => {
      const v = r[c];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const ANNOTATION_COLORS = [
  '#6366f1', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899',
];

// ── Component ─────────────────────────────────────────────────────────────

export function ChartControls({
  state,
  onChange,
  exportData,
  exportFilename = 'chart-data.csv',
  totalSteps,
  showLogScale    = true,
  showOutlierFilter = true,
  showXRange      = true,
  showExport      = true,
  showAnnotations = true,
}: ChartControlsProps) {
  const [annotationInput, setAnnotationInput] = useState('');
  const [annotationX, setAnnotationX] = useState('');
  const [annotationColorIdx, setAnnotationColorIdx] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  const set = useCallback((patch: Partial<ChartControlsState>) => {
    onChange({ ...state, ...patch });
  }, [state, onChange]);

  const addAnnotation = () => {
    const x = parseFloat(annotationX);
    if (!annotationInput.trim() || isNaN(x)) return;
    const annotation: Annotation = {
      id: `ann-${Date.now()}`,
      x,
      label: annotationInput.trim(),
      color: ANNOTATION_COLORS[annotationColorIdx % ANNOTATION_COLORS.length],
    };
    set({ annotations: [...state.annotations, annotation] });
    setAnnotationInput('');
    setAnnotationX('');
    setAnnotationColorIdx(i => (i + 1) % ANNOTATION_COLORS.length);
  };

  const removeAnnotation = (id: string) => {
    set({ annotations: state.annotations.filter(a => a.id !== id) });
  };

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
      >
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
          </svg>
          Chart Controls
        </span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${collapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 pt-2 space-y-4 border-t border-gray-200">
          <div className="flex flex-wrap gap-x-8 gap-y-3">

            {/* Log scale */}
            {showLogScale && (
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={state.logScale}
                  onChange={e => set({ logScale: e.target.checked })}
                  className="rounded accent-indigo-600"
                />
                Y-axis: log scale
              </label>
            )}

            {/* Outlier filter */}
            {showOutlierFilter && (
              <div className="flex items-center gap-2 text-sm text-gray-700">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={state.outlierSigma !== null}
                    onChange={e => set({ outlierSigma: e.target.checked ? 3 : null })}
                    className="rounded accent-indigo-600"
                  />
                  Filter outliers
                </label>
                {state.outlierSigma !== null && (
                  <>
                    <span className="text-gray-500">beyond</span>
                    <input
                      type="number"
                      value={state.outlierSigma}
                      onChange={e => set({ outlierSigma: parseFloat(e.target.value) || 3 })}
                      min={1}
                      max={5}
                      step={0.5}
                      className="w-14 rounded border border-gray-300 px-1.5 py-0.5 text-sm focus:outline-none focus:border-indigo-500"
                    />
                    <span className="text-gray-500">σ</span>
                  </>
                )}
              </div>
            )}

            {/* Export CSV */}
            {showExport && exportData && (
              <button
                onClick={() => exportCSV(exportData, exportFilename)}
                className="flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Export CSV
              </button>
            )}
          </div>

          {/* X range */}
          {showXRange && (
            <div className="flex items-center gap-3 text-sm text-gray-700">
              <span className="font-medium">X range</span>
              <input
                type="number"
                placeholder={`Start${totalSteps ? ` (1–${totalSteps})` : ''}`}
                value={state.xMin ?? ''}
                onChange={e => set({ xMin: e.target.value ? Number(e.target.value) : null })}
                className="w-24 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:border-indigo-500"
              />
              <span className="text-gray-400">–</span>
              <input
                type="number"
                placeholder={`End${totalSteps ? ` (1–${totalSteps})` : ''}`}
                value={state.xMax ?? ''}
                onChange={e => set({ xMax: e.target.value ? Number(e.target.value) : null })}
                className="w-24 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:border-indigo-500"
              />
              {(state.xMin !== null || state.xMax !== null) && (
                <button
                  onClick={() => set({ xMin: null, xMax: null })}
                  className="text-xs text-gray-400 hover:text-gray-700 underline"
                >
                  Reset
                </button>
              )}
            </div>
          )}

          {/* Annotations */}
          {showAnnotations && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-gray-700">Annotations</div>

              {state.annotations.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {state.annotations.map(a => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
                      style={{ backgroundColor: a.color + '22', color: a.color, border: `1px solid ${a.color}55` }}
                    >
                      <span className="font-mono">step {a.x}</span>
                      <span>·</span>
                      <span>{a.label}</span>
                      <button onClick={() => removeAnnotation(a.id)} className="ml-1 opacity-60 hover:opacity-100">×</button>
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="number"
                  placeholder="Step"
                  value={annotationX}
                  onChange={e => setAnnotationX(e.target.value)}
                  className="w-20 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:border-indigo-500"
                />
                <input
                  type="text"
                  placeholder="Label (e.g. 'LR drop')"
                  value={annotationInput}
                  onChange={e => setAnnotationInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addAnnotation()}
                  className="flex-1 max-w-xs rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={addAnnotation}
                  disabled={!annotationInput.trim() || !annotationX}
                  className="px-3 py-1 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Utility: apply controls to a metric array ──────────────────────────────

export function applyControls(
  data: number[],
  controls: ChartControlsState,
): { values: number[]; indices: number[] } {
  let indices = Array.from({ length: data.length }, (_, i) => i);

  // X range
  if (controls.xMin !== null) indices = indices.filter(i => i + 1 >= controls.xMin!);
  if (controls.xMax !== null) indices = indices.filter(i => i + 1 <= controls.xMax!);

  let values = indices.map(i => data[i]);

  // Outlier filter
  if (controls.outlierSigma !== null && values.length > 1) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
    const threshold = controls.outlierSigma * std;
    const filtered = indices.filter((_, j) => Math.abs(values[j] - mean) <= threshold);
    indices = filtered;
    values = indices.map(i => data[i]);
  }

  return { values, indices };
}

// ── Default state factory ──────────────────────────────────────────────────

export function defaultControlsState(): ChartControlsState {
  return {
    logScale: false,
    outlierSigma: null,
    xMin: null,
    xMax: null,
    annotations: [],
  };
}

export default ChartControls;
