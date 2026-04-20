/**
 * PyTorchRunner Resource Monitor
 * Real-time system health via PowSync reactive subscriptions.
 * No polling — updates the moment job/runner state changes via WebSocket.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
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

import { PowsyncProvider, useQuery, useConnection } from 'powsync/client';
import { getPowsyncClient } from '../../lib/powsync/client';

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

const MAX_HISTORY = 60; // 5-min window at ~5s reactive update intervals

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

// ── Inner component — uses PowSync hooks ─────────────────────────────────────

function ResourceMonitorInner() {
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const prevQueueRef = useRef(0);
  const prevActiveRef = useRef(0);
  const seenAlertKeys = useRef<Set<string>>(new Set());

  // Reactive queries — update automatically when data changes via WebSocket
  const { data: queuedJobs, isLoading: loadingQ } = useQuery({
    table: 'jobs',
    where: { status: 'queued' },
    subscribe: true,
  });
  const { data: runningJobs, isLoading: loadingR } = useQuery({
    table: 'jobs',
    where: { status: 'running' },
    subscribe: true,
  });
  const { data: runners } = useQuery({
    table: 'runners',
    subscribe: true,
  });

  // Connection state for "live" indicator
  const { isConnected } = useConnection();

  const queueSize = queuedJobs?.length ?? 0;
  const activeJobs = runningJobs?.length ?? 0;
  const mpsAvailable = (runners ?? []).some((r: any) => r.capabilities?.mps === true);
  const loading = loadingQ || loadingR;

  // Build history whenever queue/active counts change
  useEffect(() => {
    setHistory(prev => {
      const updated = [...prev, { timestamp: Date.now(), queueSize, activeJobs }];
      return updated.slice(-MAX_HISTORY);
    });
  }, [queueSize, activeJobs]);

  // Alert detection
  useEffect(() => {
    const now = Date.now();
    const newAlerts: Omit<Alert, 'id' | 'dismissed'>[] = [];

    if (!mpsAvailable && !loading) {
      newAlerts.push({ level: 'critical', message: 'MPS accelerator unavailable — jobs will run on CPU', timestamp: now });
    }
    if (queueSize > 10) {
      newAlerts.push({ level: 'warning', message: `Queue is large (${queueSize} jobs). Consider increasing workers.`, timestamp: now });
    } else if (queueSize > 5) {
      newAlerts.push({ level: 'info', message: `Queue growing: ${queueSize} jobs queued.`, timestamp: now });
    }
    if (prevActiveRef.current > 0 && activeJobs === 0) {
      newAlerts.push({ level: 'info', message: 'All active jobs have completed.', timestamp: now });
    }

    prevQueueRef.current = queueSize;
    prevActiveRef.current = activeJobs;

    if (newAlerts.length > 0) {
      setAlerts(prev => {
        const existing = [...prev];
        newAlerts.forEach(a => {
          const key = `${a.message}:${Math.floor(a.timestamp / 60000)}`;
          if (!seenAlertKeys.current.has(key)) {
            seenAlertKeys.current.add(key);
            existing.push({ ...a, id: generateId(), dismissed: false });
          }
        });
        return existing.slice(-20);
      });
    }
  }, [queueSize, activeJobs, mpsAvailable, loading]);

  const dismissAlert = (id: string) => {
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, dismissed: true } : a));
  };

  const activeAlerts = alerts.filter(a => !a.dismissed);

  const labels = history.map(h =>
    new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  );

  const queueChartData = {
    labels,
    datasets: [{
      label: 'Queue Size',
      data: history.map(h => h.queueSize),
      borderColor: 'rgb(239, 68, 68)',
      backgroundColor: 'rgba(239, 68, 68, 0.1)',
      fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
    }],
  };

  const jobsChartData = {
    labels,
    datasets: [{
      label: 'Active Jobs',
      data: history.map(h => h.activeJobs),
      borderColor: 'rgb(59, 130, 246)',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
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

  const levelColors = {
    critical: 'bg-red-50 border-red-300 text-red-800',
    warning: 'bg-yellow-50 border-yellow-300 text-yellow-800',
    info: 'bg-blue-50 border-blue-300 text-blue-800',
  };
  const levelIcon = { critical: '🔴', warning: '⚠️', info: 'ℹ️' };

  return (
    <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-400' : loading ? 'bg-yellow-400 animate-pulse' : 'bg-gray-300'}`} />
          <span className="text-sm font-medium text-gray-900">Resource Monitor</span>
          {!isConnected && (
            <span className="text-xs text-gray-400">(connecting…)</span>
          )}
          {activeAlerts.length > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
              {activeAlerts.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{isConnected ? 'Live via PowSync' : 'Reconnecting…'}</span>
          <button onClick={() => setCollapsed(c => !c)} className="text-gray-400 hover:text-gray-600">
            <svg className={`h-4 w-4 transition-transform ${collapsed ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="p-4 space-y-4">
          {/* Status cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">Service</div>
              <div className={`text-sm font-semibold ${isConnected ? 'text-green-600' : 'text-yellow-600'}`}>
                {isConnected ? 'healthy' : 'connecting'}
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">Accelerator</div>
              <div className={`text-sm font-semibold ${mpsAvailable ? 'text-green-600' : 'text-orange-500'}`}>
                {loading ? '…' : mpsAvailable ? 'MPS ✓' : 'CPU only'}
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">Queue</div>
              <div className={`text-sm font-semibold ${queueSize > 5 ? 'text-orange-500' : 'text-gray-900'}`}>
                {loading ? '…' : `${queueSize} jobs`}
              </div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">Active</div>
              <div className={`text-sm font-semibold ${activeJobs > 0 ? 'text-blue-600' : 'text-gray-900'}`}>
                {loading ? '…' : `${activeJobs} running`}
              </div>
            </div>
          </div>

          {/* Sparkline charts */}
          {history.length > 1 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">Queue Size (recent)</div>
                <div className="h-20">
                  <Line data={queueChartData} options={sparklineOptions} />
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">Active Jobs (recent)</div>
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

// ── Public export — self-contained with PowsyncProvider ──────────────────────

export function ResourceMonitor() {
  const [client] = useState(() =>
    typeof window !== 'undefined' ? getPowsyncClient() : null
  );

  if (!client) {
    return (
      <div className="bg-white shadow-sm ring-1 ring-gray-900/5 rounded-lg p-4 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-32 mb-2" />
        <div className="grid grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-gray-100 rounded-lg" />)}
        </div>
      </div>
    );
  }

  return (
    <PowsyncProvider client={client}>
      <ResourceMonitorInner />
    </PowsyncProvider>
  );
}

export default ResourceMonitor;
