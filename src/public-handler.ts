import type { Config } from './config';
import { loadConfig } from './config';
import { getServerInfo } from './server-info';
import type { Env } from './types';

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
  if (request.method === 'GET') {
    return env.ASSETS.fetch(request);
  }
  return new Response('Not Found', { status: 404 });
}
