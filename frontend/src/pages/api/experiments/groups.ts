import type { APIRoute } from 'astro';
import { proxyRequest } from '../../../lib/proxy';
export const prerender = false;

// GET /api/experiments/groups — list runs grouped by namespace
export const GET: APIRoute = async ({ url }) => {
  const qs = url.search || '';
  return proxyRequest(`/experiments/groups${qs}`);
};
