import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';

import { loadConfig } from './config';
import { addSecurityHeadersAuto } from './middleware/security-headers';
import { handleMcpRequest } from './mcp/http-handler';
import { handlePublicRequest } from './public-handler';
import { normalizeMcpRoute } from './route-normalizer';
import { serializeTelemetry, type TelemetryInput } from './telemetry';
import type { Env } from './types';

// Export MetroMcpAgent so the wrangler.jsonc DO binding can resolve the class.
// Cloudflare's bundler discovers DO classes by name at deploy time.
export { MetroMcpAgent } from './mcp-agent';

function mcpTrustRejection(
  request: Request,
  publicOrigin: string,
  allowedHostnames: string[],
  allowedOriginHostnames?: string[],
): Response | undefined {
  if (new URL(request.url).origin !== publicOrigin) {
    return Response.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid request origin' },
        id: null,
      },
      { status: 403 },
    );
  }

  return hostHeaderValidationResponse(request, allowedHostnames)
    ?? (allowedOriginHostnames
      ? originValidationResponse(request, allowedOriginHostnames)
      : undefined);
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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
          response = mcpTrustRejection(
            normalized.request,
            config.mcp.publicOrigin,
            config.mcp.allowedHostnames,
            config.mcp.allowedOriginHostnames,
          ) ?? await handleMcpRequest(normalized.request, env, config, telemetry);
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
