/**
 * In-memory runner registry.
 * Runners register on startup and are considered stale after 30s of no heartbeat.
 */

export interface Runner {
  id: string;
  hostname: string;
  capabilities: {
    mlx?: boolean;
    mps?: boolean;
    mlx_version?: string;
    cuda?: boolean;
    [key: string]: any;
  };
  namespace: string;
  currentJob: string | null;
  registeredAt: number;
  lastSeen: number;
}

// Module-level singleton — survives across requests in the same Node process
const registry = new Map<string, Runner>();

const STALE_THRESHOLD_MS = 30_000; // 30 seconds

export function registerRunner(id: string, data: Omit<Runner, 'id' | 'registeredAt' | 'lastSeen'>): Runner {
  const existing = registry.get(id);
  const runner: Runner = {
    ...data,
    id,
    registeredAt: existing?.registeredAt ?? Date.now(),
    lastSeen: Date.now(),
  };
  registry.set(id, runner);
  return runner;
}

export function heartbeatRunner(id: string, currentJob: string | null = null): Runner | null {
  const runner = registry.get(id);
  if (!runner) return null;
  runner.lastSeen = Date.now();
  runner.currentJob = currentJob;
  return runner;
}

export function getRunner(id: string): Runner | null {
  return registry.get(id) ?? null;
}

export function listRunners(includeStale = false): Runner[] {
  const now = Date.now();
  return [...registry.values()].filter(
    (r) => includeStale || now - r.lastSeen < STALE_THRESHOLD_MS
  );
}

export function removeRunner(id: string): void {
  registry.delete(id);
}
