/**
 * Astro Middleware — starts PowSync WebSocket server on first request.
 *
 * In dev mode, the `astro:server:setup` hook in realtime-integration.ts already
 * starts the WS server. This middleware is the production fallback that ensures
 * the WS server starts when running as a standalone Node.js process.
 *
 * Fire-and-forget: requests are not blocked waiting for WS server startup.
 * The SyncClient in the browser has auto-reconnect, so it will connect as soon
 * as the WS server is ready (~200ms after first request).
 */

import { defineMiddleware } from 'astro:middleware';
import { ensureStarted } from './lib/server/realtime-integration';

export const onRequest = defineMiddleware((_context, next) => {
  // Start PowSync WS server once (idempotent — singleton promise)
  // Don't await: fire-and-forget so requests aren't blocked
  ensureStarted().catch((err: Error) => {
    console.error('[middleware] PowSync startup error:', err.message);
  });
  return next();
});
