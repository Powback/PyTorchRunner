/**
 * PowSync client singleton.
 *
 * Creates one SyncClient per browser tab that connects to the WebSocket server.
 * The WS URL is derived from the current page origin so it works behind any proxy.
 *
 * Usage in React:
 *   import { powsyncClient } from '../lib/powsync/client';
 *   import { PowsyncProvider } from 'powsync/client';
 *
 *   <PowsyncProvider client={powsyncClient}>
 *     <MyComponent />
 *   </PowsyncProvider>
 *
 * Then inside components:
 *   const { data: jobs } = useQuery({ table: 'jobs', subscribe: true });
 */

import { SyncClient } from 'powsync/client';

// Side-effect import: runs @table/@field/@reducer decorators so tableRegistry
// is populated before any useQuery() call resolves a table name.
import '../../schemas/pytorch/schema';

function createPowsyncClient(): SyncClient {
  // Derive WebSocket URL from the current page.
  // - In dev: window.location.host is "localhost:4321", Vite proxies /ws → port 1239
  // - In production with Traefik: host is "pytorch.pow", Traefik routes /ws → port 1239
  const getWsUrl = () => {
    if (typeof window === 'undefined') return 'ws://localhost:1239/ws';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  };

  return new SyncClient({
    url: getWsUrl(),
    // No auth needed for this local-only service — use a fixed identity
    identity: 'pytorch-dashboard',
    reconnectDelay: 1000,
    maxReconnectAttempts: 30,
    pingIntervalMs: 30000,
    persistSession: false,
  });
}

// Module-level singleton — one client per tab, created lazily
let _client: SyncClient | null = null;

export function getPowsyncClient(): SyncClient {
  if (!_client) {
    _client = createPowsyncClient();
  }
  return _client;
}

// Named export used directly in JSX
export const powsyncClient = typeof window !== 'undefined' ? createPowsyncClient() : null as any;
