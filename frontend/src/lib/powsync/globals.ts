/**
 * PowSync Runtime Globals
 *
 * Typed access point for the global state set by realtime-integration.ts.
 * esbuild-bundled server-entry code sets these on `global` so that Vite-loaded
 * API routes can share the same singleton instances.
 *
 * Usage (reads in API routes):
 *   import { getPowsync } from '../lib/powsync/globals';
 *   const { serverStore, router } = getPowsync();
 *
 * Usage (writes — in realtime-integration.ts only):
 *   import { setPowsync } from '../lib/server/realtime-integration';
 */

const g = global as any;

export interface PowsyncGlobals {
  serverStore: any | undefined;
  router: any | undefined;
}

export function getPowsync(): PowsyncGlobals {
  return {
    serverStore: g.__pytorch_serverStore,
    router: g.__pytorch_router,
  };
}

export function setPowsync<K extends keyof PowsyncGlobals>(key: K, value: PowsyncGlobals[K]): void {
  g[`__pytorch_${key}`] = value;
}
