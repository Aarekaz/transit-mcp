import type { Config } from './config';
import { loadConfig } from './config';
import { getServerInfo } from './server-info';
import type { Env } from './types';
import {
  handleAuthorizationDecision,
  handleAuthorize,
  handleGitHubCallback,
} from './oauth/github-handler';

function methodNotAllowed(method: 'GET' | 'POST'): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: method },
  });
}

/** Serve application-owned OAuth UI, server metadata, and static assets. */
export async function handlePublicRequest(
  request: Request,
  env: Env,
  config: Config = loadConfig(env),
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === '/authorize') {
    return request.method === 'GET'
      ? handleAuthorize(request, env)
      : methodNotAllowed('GET');
  }
  if (pathname === '/callback') {
    return request.method === 'GET'
      ? handleGitHubCallback(request, env)
      : methodNotAllowed('GET');
  }
  if (pathname === '/authorize/decision') {
    return request.method === 'POST'
      ? handleAuthorizationDecision(request, env)
      : methodNotAllowed('POST');
  }
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
