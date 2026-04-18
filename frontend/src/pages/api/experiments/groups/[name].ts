import type { APIRoute } from 'astro';
import { proxyRequest } from '../../../../lib/proxy';
export const prerender = false;

// GET /api/experiments/groups/:name — summary for one namespace group
export const GET: APIRoute = async ({ params, url }) => {
  const qs = url.search || '';
  return proxyRequest(`/experiments/groups/${params.name}${qs}`);
};
