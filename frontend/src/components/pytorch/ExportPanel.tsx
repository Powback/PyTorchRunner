/**
 * PyTorchRunner Export Panel
 * Export experiment metrics as CSV, JSON, or PNG chart images.
 * Designed to work with any Chart.js chart ref and a metrics data object.
 */

import React, { useState } from 'react';

interface MetricsData {
  steps: number[];
  timestamps: number[];
  [key: string]: number[] | undefined;
}

interface ExperimentMeta {
  name?: string;
  jobId?: string;
  hyperparameters?: Record<string, any>;
  finalMetrics?: Record<string, number>;
}

interface ExportPanelProps {
  metricsData: MetricsData;
  chartRef?: React.RefObject<any>; // Chart.js instance ref
  experimentMeta?: ExperimentMeta;
  className?: string;
}

type ExportStatus = 'idle' | 'exporting' | 'done' | 'error';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeFilename(base: string): string {
  return base.replace(/[^a-z0-9_\-]/gi, '_').toLowerCase();
}

export function ExportPanel({ metricsData, chartRef, experimentMeta, className = '' }: ExportPanelProps) {
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeHyperparams, setIncludeHyperparams] = useState(true);
  const [selectedFormat, setSelectedFormat] = useState<'csv' | 'json' | 'png'>('csv');

  const baseName = safeFilename(experimentMeta?.name ?? experimentMeta?.jobId ?? 'experiment');
  const metricKeys = Object.keys(metricsData).filter(k => k !== 'steps' && k !== 'timestamps' && Array.isArray(metricsData[k]));

  // ── CSV export ────────────────────────────────────────────────────────────

  const exportCSV = () => {
    const headers = ['step', 'timestamp_ms', ...metricKeys];
    const rows = metricsData.steps.map((step, i) => [
      step,
      metricsData.timestamps[i] ?? '',
      ...metricKeys.map(k => {
        const arr = metricsData[k] as number[] | undefined;
        return arr ? (arr[i] ?? '') : '';
      }),
    ]);

    let csv = headers.join(',') + '\n';
    csv += rows.map(r => r.join(',')).join('\n');

    if (includeHyperparams && experimentMeta?.hyperparameters) {
      csv += '\n\n# Hyperparameters\n';
      Object.entries(experimentMeta.hyperparameters).forEach(([k, v]) => {
        csv += `# ${k},${v}\n`;
      });
    }

    if (experimentMeta?.finalMetrics) {
      csv += '\n# Final Metrics\n';
      Object.entries(experimentMeta.finalMetrics).forEach(([k, v]) => {
        csv += `# ${k},${v}\n`;
      });
    }

    return new Blob([csv], { type: 'text/csv' });
  };

  // ── JSON export ───────────────────────────────────────────────────────────

  const exportJSON = () => {
    const payload: Record<string, any> = {
      exportedAt: new Date().toISOString(),
      experiment: experimentMeta ?? {},
      metrics: {
        steps: metricsData.steps,
        timestamps: metricsData.timestamps,
        ...Object.fromEntries(metricKeys.map(k => [k, metricsData[k]])),
      },
    };

    if (!includeHyperparams) delete payload.experiment?.hyperparameters;

    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  };

  // ── PNG chart export ──────────────────────────────────────────────────────

  const exportPNG = (): Blob | null => {
    if (!chartRef?.current) return null;
    const chart = chartRef.current;
    const canvas: HTMLCanvasElement | null = chart.canvas ?? chart.ctx?.canvas ?? null;
    if (!canvas) return null;

    // Draw onto a white-background canvas for clean export
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ctx.drawImage(canvas, 0, 0);

    return new Promise<Blob | null>((resolve) => {
      exportCanvas.toBlob(blob => resolve(blob), 'image/png', 1.0);
    }) as any; // We'll handle async below
  };

  // ── Dispatch ──────────────────────────────────────────────────────────────

  const handleExport = async () => {
    setStatus('exporting');
    setError(null);

    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

      if (selectedFormat === 'csv') {
        const blob = exportCSV();
        downloadBlob(blob, `${baseName}_${ts}.csv`);
        setLastExport('CSV');
      } else if (selectedFormat === 'json') {
        const blob = exportJSON();
        downloadBlob(blob, `${baseName}_${ts}.json`);
        setLastExport('JSON');
      } else if (selectedFormat === 'png') {
        if (!chartRef?.current) throw new Error('No chart available to export. Make sure a chart is visible.');

        const chart = chartRef.current;
        const canvas: HTMLCanvasElement | null = chart.canvas ?? null;
        if (!canvas) throw new Error('Could not access chart canvas.');

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = canvas.width;
        exportCanvas.height = canvas.height;
        const ctx = exportCanvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        ctx.drawImage(canvas, 0, 0);

        const blob = await new Promise<Blob>((resolve, reject) => {
          exportCanvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/png', 1.0);
        });
        downloadBlob(blob, `${baseName}_chart_${ts}.png`);
        setLastExport('PNG chart');
      }

      setStatus('done');
      setTimeout(() => setStatus('idle'), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
      setStatus('error');
    }
  };

  const hasData = metricsData.steps.length > 0;

  return (
    <div className={`bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-5 ${className}`}>
      <div className="flex items-center gap-2 mb-4">
        <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
        <h3 className="text-sm font-semibold text-gray-900">Export Data</h3>
      </div>

      <div className="space-y-4">
        {/* Format selection */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">Format</label>
          <div className="flex gap-2">
            {(['csv', 'json', 'png'] as const).map(fmt => (
              <button
                key={fmt}
                onClick={() => setSelectedFormat(fmt)}
                className={`flex-1 py-2 rounded-md text-xs font-medium border transition-colors ${
                  selectedFormat === fmt
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {fmt.toUpperCase()}
                <span className="block text-xs opacity-70 font-normal">
                  {fmt === 'csv' ? 'Spreadsheet' : fmt === 'json' ? 'Raw data' : 'Chart image'}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Options */}
        {selectedFormat !== 'png' && experimentMeta?.hyperparameters && (
          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeHyperparams}
              onChange={e => setIncludeHyperparams(e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            Include hyperparameters & final metrics
          </label>
        )}

        {selectedFormat === 'png' && (
          <p className="text-xs text-gray-500">
            Exports the currently visible chart as a high-resolution PNG with white background.
          </p>
        )}

        {/* Data summary */}
        <div className="bg-gray-50 rounded-md px-3 py-2 text-xs text-gray-600">
          <div className="flex justify-between">
            <span>Data points</span>
            <span className="font-mono font-medium">{metricsData.steps.length.toLocaleString()}</span>
          </div>
          <div className="flex justify-between mt-1">
            <span>Metrics tracked</span>
            <span className="font-mono font-medium">{metricKeys.length}</span>
          </div>
          {experimentMeta?.name && (
            <div className="flex justify-between mt-1">
              <span>Experiment</span>
              <span className="font-medium truncate max-w-[140px]">{experimentMeta.name}</span>
            </div>
          )}
        </div>

        {/* Export button */}
        <button
          onClick={handleExport}
          disabled={!hasData || status === 'exporting'}
          className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-sm font-semibold shadow-sm transition-colors ${
            !hasData
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : status === 'exporting'
              ? 'bg-indigo-400 text-white cursor-wait'
              : status === 'done'
              ? 'bg-green-600 text-white hover:bg-green-700'
              : 'bg-indigo-600 text-white hover:bg-indigo-500'
          }`}
        >
          {status === 'exporting' && (
            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          {status === 'done' ? `✓ ${lastExport} downloaded` : status === 'exporting' ? 'Exporting…' : `Export ${selectedFormat.toUpperCase()}`}
        </button>

        {error && <p className="text-xs text-red-600">{error}</p>}
        {!hasData && <p className="text-xs text-gray-400 text-center">No data to export yet.</p>}
      </div>
    </div>
  );
}

export default ExportPanel;
