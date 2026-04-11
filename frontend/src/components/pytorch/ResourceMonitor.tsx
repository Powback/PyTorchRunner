/**
 * PyTorchRunner Resource Monitor
 * Real-time system health polling with anomaly detection alerts.
 * Polls /health every 5s; raises alerts for queue buildup, job failures, etc.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

import { pytorchAPI } from '../../lib/pytorch/api-client';
import type { HealthStatus } from '../../types/pytorch';

interface Alert {
  id: string;
  level: 'info' | 'warning' | 'critical';
  message: string;
  timestamp: number;
  dismissed: boolean;
}

interface HistoryPoint {
  timestamp: number;
  queueSize: number;
  activeJobs: number;
}

const MAX_HISTORY = 60; // 5-min window at 5s intervals
const POLL_INTERVAL_MS = 5000;

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

function checkForAlerts(health: HealthStatus, prev: HealthStatus | null): Omit<Alert, 'id' | 'dismissed'>[] {
  const alerts: Omit<Alert, 'id' | 'dismissed'>[] = [];
  const now = Date.now();

  if (!health.mps_available) {
    alerts.push({ level: 'critical', message: 'MPS accelerator unavailable — jobs will run on CPU', timestamp: now });
  }

  if (health.queue_size > 10) {
    alerts.push({ level: 'warning', message: `Queue is large (${health.queue_size} jobs). Consider increasing workers.`, timestamp: now });
  } else if (health.queue_size > 5) {
    alerts.push({ level: 'info', message: `Queue growing: ${health.queue_size} jobs queued.`, timestamp: now });
  }

  if (prev && health.active_jobs === 0 && prev.active_jobs > 0) {
    alerts.push({ level: 'info', message: 'All active jobs have completed.', timestamp: now });
  }

  if (health.status !== 'healthy') {
    alerts.push({ level: 'critical', message: `Service status: ${health.status}`, timestamp: now });
  }

  return alerts;
}

export function ResourceMonitor() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const prevHealthRef = useRef<HealthStatus | null>(null);
  const seenAlertKeys = useRef<Set<string>>(new Set());

  const fetchHealth = useCallback(async () => {
    try {
      const data = await pytorchAPI.getHealthStatus();

      // Check for new alert conditions
      const newRaw = checkForAlerts(data, prevHealthRef.current);
      setAlerts(prev => {
        const existing = [...prev];
        newRaw.forEach(a => {
          // Deduplicate by message within last 60s
          const key = `${a.message}:${Math.floor(a.timestamp / 60000)}`;
          if (!seenAlertKeys.current.has(key)) {
            seenAlertKeys.current.add(key);
            existing.push({ ...a, id: generateId(), dismissed: false });
          }
        });
        // Keep only last 20 alerts
        return existing.slice(-20);
      });

      prevHealthRef.current = data;
      setHealth(data);
      setError(null);

      setHistory(prev => {
        const updated = [...prev, { timestamp: Date.now(), queueSize: data.queue_size, activeJobs: data.active_jobs }];
        return updated.slice(-MAX_HISTORY);
      });
    } catch (err) {
      setError('Cannot reach API server');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const timer = setInterval(fetchHealth, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchHealth]);

  const dismissAlert = (id: string) => {
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, dismissed: true } : a));
  };

  const activeAlerts = alerts.filter(a => !a.dismissed);

  // Chart data for history sparklines
  const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

  const queueChartData = {
    labels,
    datasets: [{
      label: 'Queue Size',
      data: history.map(h => h.queueSize),
      borderColor: 'rgb(239, 68, 68)',
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    }],
  };

  const jobsChartData = {
    labels,
    datasets: [{
      label: 'Active Jobs',
      data: history.map(h => h.activeJobs),
      borderColor: 'rgb(59, 130, 246)',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    }],
  };

  const sparklineOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    scales: {
      x: { display: false },
      y: { display: true, beginAtZero: true, ticks: { maxTicksLimit: 3, font: { size: 10 } } },
    },
    plugins: { legend: { display: false }, tooltip: { mode: 'index' as const, intersect: false } },
  };

  const levelColors: Record<Alert['level'], string> = {
    critical: 'bg-red-50 border-red-300 text-red-800',
    warning: 'bg-yellow-50 border-yellow-300 text-yellow-800',
    info: 'bg-blue-50 border-blue-300 text-blue-800',
  };

  const levelIcon: Record<Alert['level'], string> = {
    critical: '🔴',
    warning: '⚠️',
    info: 'ℹ️',
  };

  return (
    <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${error ? 'bg-red-400' : loading ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}`} />
          <span className="text-sm font-medium text-gray-900">Resource Monitor</span>
          {activeAlerts.length > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
              {activeAlerts.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">Updated every 5s</span>
          <button onClick={() => setCollapsed(c => !c)} className="text-gray-400 hover:text-gray-600">
            <svg className={`h-4 w-4 transition-transform ${collapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="p-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-xs text-red-700">
              {error} — check that the script-executor API is running on port 9100.
            </div>
          )}

          {/* Status cards */}
          {health && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Service</div>
                <div className={`text-sm font-semibold ${health.status === 'healthy' ? 'text-green-600' : 'text-red-600'}`}>
                  {health.status}
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Accelerator</div>
                <div className={`text-sm font-semibold ${health.mps_available ? 'text-green-600' : 'text-orange-500'}`}>
                  {health.mps_available ? 'MPS ✓' : 'CPU only'}
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Queue</div>
                <div className={`text-sm font-semibold ${health.queue_size > 5 ? 'text-orange-500' : 'text-gray-900'}`}>
                  {health.queue_size} jobs
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs text-gray-500 mb-1">Active</div>
                <div className={`text-sm font-semibold ${health.active_jobs > 0 ? 'text-blue-600' : 'text-gray-900'}`}>
                  {health.active_jobs} running
                </div>
              </div>
            </div>
          )}

          {/* Sparkline charts */}
          {history.length > 1 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">Queue Size (last 5 min)</div>
                <div className="h-20">
                  <Line data={queueChartData} options={sparklineOptions} />
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">Active Jobs (last 5 min)</div>
                <div className="h-20">
                  <Line data={jobsChartData} options={sparklineOptions} />
                </div>
              </div>
            </div>
          )}

          {/* Alerts */}
          {activeAlerts.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Alerts</div>
              {activeAlerts.slice(-5).map(alert => (
                <div key={alert.id} className={`flex items-start justify-between gap-2 border rounded-md px-3 py-2 text-xs ${levelColors[alert.level]}`}>
                  <div className="flex items-start gap-1.5">
                    <span>{levelIcon[alert.level]}</span>
                    <div>
                      <span>{alert.message}</span>
                      <span className="ml-2 opacity-60">{new Date(alert.timestamp).toLocaleTimeString()}</span>
                    </div>
                  </div>
                  <button onClick={() => dismissAlert(alert.id)} className="flex-shrink-0 opacity-50 hover:opacity-100">
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ResourceMonitor;
