/**
 * PyTorchRunner Experiment Dashboard
 * Real-time visualization of training metrics, live output, and job monitoring
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  Filler
} from 'chart.js';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

import { pytorchAPI } from '../../lib/pytorch/api-client';
import type { PyTorchJob, PyTorchExperiment, SSEJobEvent, MetricsChartData } from '../../types/pytorch';

// Chart configuration
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false, // Disable for real-time updates
  interaction: {
    intersect: false,
    mode: 'index' as const,
  },
  scales: {
    x: {
      title: {
        display: true,
        text: 'Step'
      },
      type: 'linear' as const
    },
    y: {
      title: {
        display: true,
        text: 'Value'
      },
      beginAtZero: false
    }
  },
  plugins: {
    legend: {
      position: 'top' as const,
    },
    tooltip: {
      filter: (tooltipItem: any) => tooltipItem.datasetIndex !== undefined
    }
  }
};

interface ExperimentDashboardProps {
  experimentId?: number;
  jobId?: string;
  autoRefresh?: boolean;
}

interface MetricsData {
  loss: number[];
  accuracy?: number[];
  learningRate?: number[];
  timestamps: number[];
  steps: number[];
}

interface OutputLine {
  timestamp: number;
  line: string;
  stream: 'stdout' | 'stderr';
  lineNo: number;
}

export function ExperimentDashboard({
  experimentId,
  jobId,
  autoRefresh = true
}: ExperimentDashboardProps) {
  // State management
  const [job, setJob] = useState<PyTorchJob | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsData>({
    loss: [],
    accuracy: [],
    learningRate: [],
    timestamps: [],
    steps: []
  });
  const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetrics, setSelectedMetrics] = useState<Set<string>>(new Set(['loss']));

  // Refs for auto-scroll and SSE
  const outputRef = useRef<HTMLDivElement>(null);
  const sseRef = useRef<EventSource | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Initialize data loading and SSE connection
  useEffect(() => {
    if (!jobId) return;

    let isMounted = true;

    const initializeDashboard = async () => {
      try {
        setError(null);

        // Load initial job data
        const jobData = await pytorchAPI.getJobStatus(jobId);
        if (isMounted) {
          setJob(jobData);
        }

        // Start SSE connection for real-time updates
        if (autoRefresh) {
          startSSEConnection();
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load job data');
        }
      }
    };

    initializeDashboard();

    return () => {
      isMounted = false;
      stopSSEConnection();
    };
  }, [jobId, autoRefresh]);

  // Start SSE connection for real-time updates
  const startSSEConnection = () => {
    if (!jobId || sseRef.current) return;

    try {
      console.log(`Starting SSE connection for job ${jobId}`);
      const eventSource = pytorchAPI.createJobStream(jobId);
      sseRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('SSE connection opened');
        setIsConnected(true);
        setError(null);
      };

      eventSource.onmessage = (event) => {
        try {
          const data = pytorchAPI.parseSSEEvent(event);
          if (data) {
            handleSSEEvent(data);
          }
        } catch (err) {
          console.error('Failed to parse SSE event:', err);
        }
      };

      eventSource.onerror = (err) => {
        console.error('SSE connection error:', err);
        setIsConnected(false);
        setError('Connection lost. Attempting to reconnect...');

        // Auto-reconnect after delay
        setTimeout(() => {
          if (sseRef.current?.readyState === EventSource.CLOSED) {
            startSSEConnection();
          }
        }, 5000);
      };

    } catch (err) {
      setError('Failed to establish real-time connection');
      console.error('SSE connection failed:', err);
    }
  };

  // Stop SSE connection
  const stopSSEConnection = () => {
    if (sseRef.current) {
      console.log('Closing SSE connection');
      sseRef.current.close();
      sseRef.current = null;
      setIsConnected(false);
    }
  };

  // Handle SSE events
  const handleSSEEvent = (event: SSEJobEvent) => {
    switch (event.type) {
      case 'stdout':
      case 'stderr':
        if (event.line && event.line_no !== undefined) {
          const outputLine: OutputLine = {
            timestamp: Date.now(),
            line: event.line,
            stream: event.type,
            lineNo: event.line_no
          };

          setOutputLines(prev => {
            const updated = [...prev, outputLine];
            // Keep only last 500 lines to prevent memory issues
            return updated.slice(-500);
          });

          // Auto-scroll to bottom
          if (autoScroll && outputRef.current) {
            setTimeout(() => {
              outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' });
            }, 50);
          }

          // Try to parse metrics from output
          const parsedMetrics = parseMetricsFromLine(event.line);
          if (parsedMetrics) {
            updateMetricsData(parsedMetrics);
          }
        }
        break;

      case 'status':
        if (job) {
          setJob(prev => prev ? {
            ...prev,
            status: event.status || prev.status,
            progress: event.progress !== undefined ? event.progress : prev.progress
          } : prev);
        }
        break;

      case 'metrics':
        if (event.metrics) {
          updateMetricsData({
            metrics: event.metrics,
            step: event.step || metricsData.steps.length,
            epoch: event.epoch
          });
        }
        break;

      case 'done':
        console.log('Job completed:', event);
        setIsConnected(false);
        if (job) {
          setJob(prev => prev ? {
            ...prev,
            status: event.status || 'completed',
            progress: 1.0,
            exitCode: event.exit_code || 0
          } : prev);
        }
        stopSSEConnection();
        break;
    }
  };

  // Parse metrics from output line
  const parseMetricsFromLine = (line: string): { metrics: Record<string, number>; step?: number; epoch?: number } | null => {
    // Pattern for "Epoch 5/10, Step 100, Loss: 0.234, Accuracy: 0.92"
    const epochStepPattern = /Epoch (\d+)(?:\/\d+)?,?\s*Step (\d+),?\s*Loss:\s*([\d.]+)(?:,?\s*Acc(?:uracy)?:\s*([\d.]+))?/i;
    const match = line.match(epochStepPattern);

    if (match) {
      const metrics: Record<string, number> = {
        loss: parseFloat(match[3])
      };

      if (match[4]) {
        metrics.accuracy = parseFloat(match[4]);
      }

      return {
        metrics,
        epoch: parseInt(match[1]),
        step: parseInt(match[2])
      };
    }

    // Simple loss pattern: "Loss: 0.234"
    const lossPattern = /Loss:\s*([\d.]+)/i;
    const lossMatch = line.match(lossPattern);
    if (lossMatch) {
      return {
        metrics: { loss: parseFloat(lossMatch[1]) }
      };
    }

    return null;
  };

  // Update metrics data
  const updateMetricsData = (update: { metrics: Record<string, number>; step?: number; epoch?: number }) => {
    setMetricsData(prev => {
      const newStep = update.step !== undefined ? update.step : prev.steps.length;
      const newTimestamp = Date.now();

      const updated = { ...prev };

      // Add new step and timestamp
      updated.steps = [...prev.steps, newStep];
      updated.timestamps = [...prev.timestamps, newTimestamp];

      // Add metric values
      Object.entries(update.metrics).forEach(([key, value]) => {
        if (typeof value === 'number') {
          if (!updated[key as keyof MetricsData]) {
            (updated as any)[key] = [];
          }
          (updated as any)[key].push(value);
        }
      });

      // Keep only last 1000 points for performance
      const maxPoints = 1000;
      if (updated.steps.length > maxPoints) {
        updated.steps = updated.steps.slice(-maxPoints);
        updated.timestamps = updated.timestamps.slice(-maxPoints);

        Object.keys(updated).forEach(key => {
          if (Array.isArray((updated as any)[key]) && key !== 'steps' && key !== 'timestamps') {
            (updated as any)[key] = (updated as any)[key].slice(-maxPoints);
          }
        });
      }

      return updated;
    });
  };

  // Prepare chart data
  const chartData: MetricsChartData = useMemo(() => {
    const datasets = [];

    if (selectedMetrics.has('loss') && metricsData.loss.length > 0) {
      datasets.push({
        label: 'Loss',
        data: metricsData.steps.map((step, i) => ({ x: step, y: metricsData.loss[i] })),
        borderColor: 'rgb(239, 68, 68)',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        tension: 0.1
      });
    }

    if (selectedMetrics.has('accuracy') && metricsData.accuracy && metricsData.accuracy.length > 0) {
      datasets.push({
        label: 'Accuracy',
        data: metricsData.steps.map((step, i) => ({ x: step, y: metricsData.accuracy![i] })),
        borderColor: 'rgb(34, 197, 94)',
        backgroundColor: 'rgba(34, 197, 94, 0.1)',
        tension: 0.1
      });
    }

    if (selectedMetrics.has('learningRate') && metricsData.learningRate && metricsData.learningRate.length > 0) {
      datasets.push({
        label: 'Learning Rate',
        data: metricsData.steps.map((step, i) => ({ x: step, y: metricsData.learningRate![i] })),
        borderColor: 'rgb(168, 85, 247)',
        backgroundColor: 'rgba(168, 85, 247, 0.1)',
        tension: 0.1
      });
    }

    return { datasets };
  }, [metricsData, selectedMetrics]);

  // Get status color
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-600 bg-green-100';
      case 'running': return 'text-blue-600 bg-blue-100';
      case 'failed': return 'text-red-600 bg-red-100';
      case 'cancelled': return 'text-gray-600 bg-gray-100';
      default: return 'text-yellow-600 bg-yellow-100';
    }
  };

  // Handle metric selection toggle
  const toggleMetric = (metric: string) => {
    setSelectedMetrics(prev => {
      const updated = new Set(prev);
      if (updated.has(metric)) {
        updated.delete(metric);
      } else {
        updated.add(metric);
      }
      return updated;
    });
  };

  // Cancel job
  const handleCancelJob = async () => {
    if (!jobId) return;

    try {
      await pytorchAPI.cancelJob(jobId);
      if (job) {
        setJob({ ...job, status: 'cancelled' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    }
  };

  if (!jobId) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500">No job selected for monitoring</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error banner — shown even before job data loads */}
      {error && !job && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Job Status Header */}
      {job && (
        <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Job {job.jobId}</h2>
              <p className="text-sm text-gray-500">Experiment {experimentId || 'Unknown'}</p>
            </div>
            <div className="flex items-center space-x-3">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(job.status)}`}>
                {job.status}
              </span>
              <div className={`h-3 w-3 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`}
                   title={isConnected ? 'Connected' : 'Disconnected'} />
            </div>
          </div>

          {/* Progress Bar */}
          {job.status === 'running' && (
            <div className="mb-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Progress</span>
                <span className="text-gray-900">{Math.round(job.progress * 100)}%</span>
              </div>
              <div className="mt-1 bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${job.progress * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Job Actions */}
          <div className="flex items-center justify-between">
            <div className="flex space-x-4 text-sm text-gray-600">
              <span>Started: {job.startedAt ? pytorchAPI.formatTimestamp(job.startedAt) : 'Not started'}</span>
              {job.completedAt && (
                <span>Completed: {pytorchAPI.formatTimestamp(job.completedAt)}</span>
              )}
            </div>
            {job.status === 'running' && (
              <button
                onClick={handleCancelJob}
                className="inline-flex items-center px-3 py-1.5 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50"
              >
                Cancel Job
              </button>
            )}
          </div>

          {error && (
            <div className="mt-4 bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>
      )}

      {/* Metrics Visualization */}
      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">Training Metrics</h3>

          {/* Metric Selection */}
          <div className="flex space-x-2">
            {(['loss', 'accuracy', 'learningRate'] as const).map(metric => {
              const hasData = metricsData[metric] && metricsData[metric]!.length > 0;
              return (
                <button
                  key={metric}
                  onClick={() => toggleMetric(metric)}
                  disabled={!hasData}
                  className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                    selectedMetrics.has(metric)
                      ? 'bg-blue-100 text-blue-800'
                      : hasData
                      ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      : 'bg-gray-50 text-gray-400 cursor-not-allowed'
                  }`}
                >
                  {metric.charAt(0).toUpperCase() + metric.slice(1)}
                  {hasData && ` (${metricsData[metric]!.length})`}
                </button>
              );
            })}
          </div>
        </div>

        {chartData.datasets.length > 0 ? (
          <div className="h-80">
            <Line data={chartData} options={chartOptions} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-80 text-gray-500">
            <div className="text-center">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <p>No metrics data available</p>
              <p className="text-sm">Metrics will appear here as the job runs</p>
            </div>
          </div>
        )}
      </div>

      {/* Live Output */}
      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">Live Output</h3>
          <div className="flex items-center space-x-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="ml-2 text-sm text-gray-600">Auto-scroll</span>
            </label>
            <span className="text-sm text-gray-500">
              {outputLines.length} lines
            </span>
          </div>
        </div>

        <div
          ref={outputRef}
          className="bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-sm h-80 overflow-y-auto"
        >
          {outputLines.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              <p>Output will appear here when the job starts...</p>
            </div>
          ) : (
            outputLines.map((line, index) => (
              <div
                key={`${line.lineNo}-${index}`}
                className={`${line.stream === 'stderr' ? 'text-red-400' : 'text-gray-100'}`}
              >
                <span className="text-gray-500 mr-2">{String(line.lineNo + 1).padStart(4, ' ')}</span>
                {line.line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default ExperimentDashboard;