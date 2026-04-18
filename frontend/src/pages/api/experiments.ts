import type { APIRoute } from 'astro';
import { proxyRequest } from '../../lib/proxy';
export const prerender = false;

// GET /api/experiments?status=&search=&tags=&limit=&offset=
export const GET: APIRoute = async ({ url }) => {
  const qs = url.search || '';
  return proxyRequest(`/experiments${qs}`);
};
