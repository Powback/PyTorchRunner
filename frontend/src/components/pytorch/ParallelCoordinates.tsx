/**
 * ParallelCoordinates
 * SVG-based parallel coordinates chart.
 * Each vertical axis = one hyperparameter or metric.
 * Each polyline = one run, colored by performance on a target metric.
 * Hover to highlight a run. Click to pin/unpin.
 */

import React, { useState, useRef, useMemo, useCallback } from 'react';

export interface PCRun {
  jobId: string;
  name: string;
  values: Record<string, number>; // dimension → numeric value
  status: string;
}

interface ParallelCoordinatesProps {
  runs: PCRun[];
  dimensions: string[];          // ordered list of axis names
  targetMetric?: string;         // dimension used to color lines
  height?: number;
}

// Interpolate between red (poor) → yellow → green (best)
function perfColor(norm: number, alpha = 0.7): string {
  // norm: 0 = worst (red), 1 = best (green)
  const r = norm < 0.5 ? 220 : Math.round(220 - 220 * (norm - 0.5) * 2);
  const g = norm > 0.5 ? 160 : Math.round(160 * norm * 2);
  const b = 60;
  return `rgba(${r},${g},${b},${alpha})`;
}

const MARGIN = { top: 32, right: 24, bottom: 48, left: 24 };

export function ParallelCoordinates({
  runs,
  dimensions,
  targetMetric,
  height = 320,
}: ParallelCoordinatesProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(700);

  // Measure container width
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const obs = new ResizeObserver(entries => {
      setContainerWidth(entries[0].contentRect.width);
    });
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  const innerW = containerWidth - MARGIN.left - MARGIN.right;
  const innerH = height - MARGIN.top - MARGIN.bottom;

  // Filter dimensions that have at least one value across runs
  const activeDims = useMemo(() =>
    dimensions.filter(d => runs.some(r => r.values[d] !== undefined)),
    [dimensions, runs]
  );

  // Per-dimension: min, max for normalisation
  const scales = useMemo(() => {
    const s: Record<string, { min: number; max: number }> = {};
    for (const d of activeDims) {
      const vals = runs.map(r => r.values[d]).filter(v => v !== undefined) as number[];
      if (vals.length === 0) { s[d] = { min: 0, max: 1 }; continue; }
      const mn = Math.min(...vals);
      const mx = Math.max(...vals);
      s[d] = { min: mn, max: mx === mn ? mn + 1 : mx };
    }
    return s;
  }, [activeDims, runs]);

  const axisXs = useMemo(() => {
    if (activeDims.length === 0) return [];
    if (activeDims.length === 1) return [innerW / 2];
    return activeDims.map((_, i) => (i / (activeDims.length - 1)) * innerW);
  }, [activeDims, innerW]);

  // Normalise [0,1] — for metrics where lower=better we invert for color
  function normY(dim: string, val: number): number {
    const { min, max } = scales[dim] || { min: 0, max: 1 };
    return (val - min) / (max - min);
  }

  // Y coordinate: high normalised value at top (inverted SVG y)
  function yCoord(dim: string, val: number): number {
    return innerH * (1 - normY(dim, val));
  }

  // Performance color — normalized score on targetMetric
  const getColor = useMemo(() => {
    if (!targetMetric || !scales[targetMetric]) return (_id: string) => 'rgba(100,116,139,0.5)';
    const isLoss = targetMetric.toLowerCase().includes('loss') ||
                   targetMetric.toLowerCase().includes('error');
    return (jobId: string) => {
      const r = runs.find(r => r.jobId === jobId);
      if (!r || r.values[targetMetric] === undefined) return 'rgba(100,116,139,0.4)';
      const n = normY(targetMetric, r.values[targetMetric]);
      return perfColor(isLoss ? 1 - n : n, 0.65);
    };
  }, [runs, targetMetric, scales]);

  // Build polyline points for a run
  function runPoints(run: PCRun): string {
    return activeDims
      .map((d, i) => {
        const v = run.values[d];
        if (v === undefined) return null;
        return `${axisXs[i]},${yCoord(d, v)}`;
      })
      .filter(Boolean)
      .join(' ');
  }

  const activeRun = pinnedId || hoveredId;

  if (runs.length === 0 || activeDims.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 text-sm">
        No data available for parallel coordinates.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Info bar */}
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{runs.length} runs · {activeDims.length} dimensions</span>
        {activeRun && (
          <span className="text-indigo-600 font-medium">
            {runs.find(r => r.jobId === activeRun)?.name ?? activeRun.slice(0, 8)}
            {pinnedId && ' (pinned)'}
          </span>
        )}
        {pinnedId && (
          <button
            onClick={() => setPinnedId(null)}
            className="text-xs text-gray-400 hover:text-gray-700 underline"
          >
            Unpin
          </button>
        )}
      </div>

      {/* SVG chart */}
      <div ref={containerRef} className="w-full overflow-x-auto">
        <svg
          ref={svgRef}
          width={containerWidth}
          height={height}
          className="select-none"
        >
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {/* Background lines (dim, non-active runs) */}
            {runs.map(run => {
              const pts = runPoints(run);
              if (!pts) return null;
              const isActive = run.jobId === activeRun;
              if (isActive) return null; // rendered on top below
              return (
                <polyline
                  key={run.jobId}
                  points={pts}
                  fill="none"
                  stroke={getColor(run.jobId)}
                  strokeWidth={activeRun && run.jobId !== activeRun ? 1 : 1.5}
                  opacity={activeRun ? 0.2 : 1}
                  style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
                  onMouseEnter={() => !pinnedId && setHoveredId(run.jobId)}
                  onMouseLeave={() => !pinnedId && setHoveredId(null)}
                  onClick={() => setPinnedId(pinnedId === run.jobId ? null : run.jobId)}
                />
              );
            })}

            {/* Active (highlighted) run on top */}
            {activeRun && (() => {
              const run = runs.find(r => r.jobId === activeRun);
              if (!run) return null;
              const pts = runPoints(run);
              if (!pts) return null;
              return (
                <polyline
                  key={`active-${run.jobId}`}
                  points={pts}
                  fill="none"
                  stroke={getColor(run.jobId)}
                  strokeWidth={3}
                  opacity={1}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setPinnedId(pinnedId === run.jobId ? null : run.jobId)}
                />
              );
            })()}

            {/* Axes */}
            {activeDims.map((dim, i) => {
              const x = axisXs[i];
              const { min, max } = scales[dim];
              const tickCount = 4;
              const ticks = Array.from({ length: tickCount + 1 }, (_, ti) => {
                const t = min + (max - min) * (ti / tickCount);
                return { y: yCoord(dim, t), label: formatAxisTick(t) };
              });

              return (
                <g key={dim}>
                  {/* Axis line */}
                  <line x1={x} y1={0} x2={x} y2={innerH} stroke="#d1d5db" strokeWidth={1.5} />

                  {/* Tick marks */}
                  {ticks.map(({ y, label }, ti) => (
                    <g key={ti}>
                      <line x1={x - 4} y1={y} x2={x + 4} y2={y} stroke="#9ca3af" strokeWidth={1} />
                      <text
                        x={x}
                        y={y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={9}
                        fill="#9ca3af"
                        dx={i === 0 ? 18 : i === activeDims.length - 1 ? -18 : 0}
                        dy={i === 0 || i === activeDims.length - 1 ? 0 : -8}
                      >
                        {label}
                      </text>
                    </g>
                  ))}

                  {/* Axis label */}
                  <text
                    x={x}
                    y={innerH + 20}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight={600}
                    fill="#374151"
                    style={{ maxWidth: `${innerW / activeDims.length - 8}px` }}
                  >
                    {truncateLabel(dim, 14)}
                  </text>
                </g>
              );
            })}

            {/* Invisible hit targets for lines */}
            {runs.map(run => {
              const pts = runPoints(run);
              if (!pts) return null;
              return (
                <polyline
                  key={`hit-${run.jobId}`}
                  points={pts}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => !pinnedId && setHoveredId(run.jobId)}
                  onMouseLeave={() => !pinnedId && setHoveredId(null)}
                  onClick={() => setPinnedId(pinnedId === run.jobId ? null : run.jobId)}
                />
              );
            })}
          </g>
        </svg>
      </div>

      {/* Tooltip card for active run */}
      {activeRun && (() => {
        const run = runs.find(r => r.jobId === activeRun);
        if (!run) return null;
        return (
          <div className="bg-gray-50 rounded-lg px-4 py-3 border border-gray-200 text-xs">
            <div className="font-semibold text-gray-800 mb-2">{run.name}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1">
              {activeDims.map(d => {
                const v = run.values[d];
                if (v === undefined) return null;
                return (
                  <div key={d} className="flex justify-between gap-2">
                    <span className="text-gray-500 truncate">{d}</span>
                    <span className="font-mono text-gray-800">{formatAxisTick(v)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function formatAxisTick(v: number): string {
  if (Math.abs(v) >= 10000 || (Math.abs(v) < 0.001 && v !== 0)) return v.toExponential(1);
  if (Number.isInteger(v)) return String(v);
  return parseFloat(v.toPrecision(3)).toString();
}

function truncateLabel(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export default ParallelCoordinates;
