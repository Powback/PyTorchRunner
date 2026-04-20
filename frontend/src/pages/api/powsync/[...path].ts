/**
 * PowSync catch-all API route
 *
 * Delegates to ReducerRouter.executeFromHttp() for all @api-decorated reducers.
 * All reducers decorated with @api('/some/path') are accessible via:
 *   POST /api/powsync/some/path
 *
 * Also used internally by API routes that call dispatchToStore() to notify
 * subscribed clients after PostgreSQL writes.
 */

import type { APIRoute } from 'astro';
import { getPowsync } from '../../../lib/powsync/globals';

export const prerender = false;

export const ALL: APIRoute = async ({ request, params }) => {
  const path = '/' + (params.path ?? '');
  const method = request.method;

  const { router } = getPowsync();
  if (!router) {
    return new Response(JSON.stringify({ success: false, error: 'PowSync not ready' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any = {};
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  } else {
    const url = new URL(request.url);
    for (const [key, value] of url.searchParams) {
      body[key] = value;
    }
  }

  const result = await router.executeFromHttp(path, method, body, 'API_SYSTEM', {
    origin: request.headers.get('origin') ?? undefined,
  });

  return new Response(JSON.stringify({
    success: result.success,
    data: result.result,
    error: result.error,
  }), {
    status: result.success ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
};
