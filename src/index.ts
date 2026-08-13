import { loadConfig } from './config';
import { addSecurityHeadersAuto } from './middleware/security-headers';
import { createOAuthProvider } from './oauth/provider';
import { handlePublicRequest } from './public-handler';
import { normalizeMcpRoute } from './route-normalizer';
import { serializeTelemetry, type TelemetryInput } from './telemetry';
import type { Env } from './types';

// Export MetroMcpAgent so the wrangler.jsonc DO binding can resolve the class.
// Cloudflare's bundler discovers DO classes by name at deploy time.
export { MetroMcpAgent } from './mcp-agent';

function isOAuthRoute(pathname: string): boolean {
  return pathname === '/authorize'
    || pathname === '/authorize/decision'
    || pathname === '/callback'
    || pathname === '/token'
    || pathname === '/register'
    || pathname === '/.well-known/oauth-authorization-server'
    || pathname === '/.well-known/oauth-protected-resource'
    || pathname.startsWith('/.well-known/oauth-protected-resource/');
}

function withCorrelationId(response: Response, correlationId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Request-ID', correlationId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = performance.now();
    const telemetry: TelemetryInput = { correlationId: crypto.randomUUID() };
    const normalized = normalizeMcpRoute(request);
    let response: Response;

    try {
      if (normalized instanceof Response) {
        response = normalized;
      } else {
        const config = loadConfig(env);
        if (normalized) {
          telemetry.alias = normalized.alias;
          response = await createOAuthProvider(env, ctx, config, telemetry)
            .fetch(normalized.request, env, ctx);
        } else if (isOAuthRoute(new URL(request.url).pathname)) {
          response = await createOAuthProvider(env, ctx, config, telemetry).fetch(request, env, ctx);
        } else {
          response = await handlePublicRequest(request, env, config);
        }
      }
    } catch {
      response = Response.json(
        { error: 'internal_server_error' },
        { status: 500 },
      );
    }

    telemetry.durationMs = Math.max(0, performance.now() - startedAt);
    telemetry.status = response.status;
    const correlationId = typeof telemetry.correlationId === 'string'
      ? telemetry.correlationId
      : crypto.randomUUID();
    const secured = addSecurityHeadersAuto(withCorrelationId(response, correlationId));
    console.info(serializeTelemetry(telemetry));
    return secured;
  }
};
