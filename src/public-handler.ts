import type { Config } from './config';
import { loadConfig } from './config';
import { getServerInfo } from './server-info';
import type { Env } from './types';

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
  if (pathname === '/.well-known/openai-apps-challenge' && request.method === 'GET') {
    return new Response(OPENAI_APPS_CHALLENGE, {
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }
  if (request.method === 'GET') {
    return env.ASSETS.fetch(request);
  }
  return new Response('Not Found', { status: 404 });
}
