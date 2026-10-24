import type { Config } from './config';
import { loadConfig } from './config';
import { getServerInfo } from './server-info';
import type { Env } from './types';
import { canaryHealthResponse } from './canary';

const OPENAI_APPS_CHALLENGE = 'A4dphR5uRWU44rm5ytkVkwHt8wj3aJmxoRja8nLMnsg';

/** Serve public server metadata and static assets. */
export async function handlePublicRequest(
  request: Request,
  env: Env,
  config: Config = loadConfig(env),
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/info' && request.method === 'GET') {
    return new Response(JSON.stringify(getServerInfo(config.mcp.publicOrigin), null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  if (pathname === '/health/deep' && request.method === 'GET') return canaryHealthResponse(env);
  if (pathname === '/.well-known/openai-apps-challenge' && request.method === 'GET') {
    return new Response(OPENAI_APPS_CHALLENGE, {
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return withByteRange(request, await env.ASSETS.fetch(request));
  }
  return new Response('Not Found', { status: 404 });
}

/** The asset binding answers a Range request with the whole file. Apple's players
 * (iMessage link previews, Safari) will not play an MP4 without 206 Partial Content. */
async function withByteRange(request: Request, response: Response): Promise<Response> {
  if (response.status !== 200 || !response.body || response.headers.has('Content-Encoding')) return response;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range')?.trim() ?? '');
  if (!range) {
    if (!response.headers.get('Content-Type')?.startsWith('video/')) return response;
    const headers = new Headers(response.headers); headers.set('Accept-Ranges', 'bytes');
    return new Response(response.body, { status: 200, headers });
  }
  const body = new Uint8Array(await response.arrayBuffer()), size = body.length;
  const [, from, to] = range;
  const start = from ? Number(from) : Math.max(0, size - Number(to));
  const end = from && to ? Math.min(Number(to), size - 1) : size - 1;
  const headers = new Headers(response.headers); headers.set('Accept-Ranges', 'bytes'); headers.delete('Content-Length');
  if ((!from && !to) || start > end || start >= size) {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}
