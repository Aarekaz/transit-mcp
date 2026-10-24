import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';

import { loadConfig } from './config';
import { recordMcpUsage } from './metrics';
import { addSecurityHeadersAuto } from './middleware/security-headers';
import { handleMcpRequest } from './mcp/http-handler';
import { handlePublicRequest } from './public-handler';
import { anonymousMcpRateLimitResponse } from './rate-limit';
import { normalizeMcpRoute } from './route-normalizer';
import { requestTelemetry, serializeTelemetry, type TelemetryInput } from './telemetry';
import type { Env } from './types';
import { bootstrapRegionalFeedHub } from './transit/gtfs/realtime/bootstrap';
import { checkStaticSources, rollForwardSchedules } from './transit/gtfs/refresh/refresh';
import { compactSchedules } from './transit/planner/compactor';
import { canaryDue, canaryRecheckDue, recordCanary } from './canary';

// Export MetroMcpAgent so the wrangler.jsonc DO binding can resolve the class.
// Cloudflare's bundler discovers DO classes by name at deploy time.
export { MetroMcpAgent } from './mcp-agent';
export { RegionFeedHub } from './transit/gtfs/realtime/region-feed-hub';
export { TransitRefreshWorkflow } from './transit/gtfs/refresh/workflow';

function mcpTrustRejection(
  request: Request,
  publicOrigin: string,
  allowedHostnames: string[],
  allowedOriginHostnames?: string[],
): Response | undefined {
  // The canonical origin (including loopback development) is always trusted;
  // any other custom domain must be HTTPS on the default port and allowlisted.
  const url = new URL(request.url);
  const isAllowedCustomDomain = url.protocol === 'https:'
    && url.port === ''
    && allowedHostnames.includes(url.hostname.toLowerCase());
  if (url.origin !== publicOrigin && !isAllowedCustomDomain) {
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
          const trustRejection = mcpTrustRejection(
            normalized.request,
            config.mcp.publicOrigin,
            config.mcp.allowedHostnames,
            config.mcp.allowedOriginHostnames,
          );
          if (trustRejection) {
            response = trustRejection;
          } else if (normalized.request.method === 'POST') {
            response = await anonymousMcpRateLimitResponse(
              normalized.request,
              env.MCP_RATE_LIMITER,
            ) ?? await requestTelemetry.run(telemetry, () => handleMcpRequest(normalized.request, env, config, telemetry));
          } else {
            response = await requestTelemetry.run(telemetry, () => handleMcpRequest(normalized.request, env, config, telemetry));
          }
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
    const streamed = telemetry.mcpMethod === 'tools/call' && response.body !== null;
    if (!streamed) recordMcpUsage(env, telemetry);
    const correlationId = typeof telemetry.correlationId === 'string'
      ? telemetry.correlationId
      : crypto.randomUUID();
    const secured = addSecurityHeadersAuto(withCorrelationId(response, correlationId));
    console.info(serializeTelemetry(telemetry));
    if (!streamed) return secured;
    if (!secured.body) { recordMcpUsage(env, telemetry); return secured; }
    // A tool runs while its response streams: count the call once the body has ended (or
    // the client went away), when the answer's regions and feeds are known.
    const { readable, writable } = new TransformStream();
    ctx.waitUntil(secured.body.pipeTo(writable).catch(() => {}).finally(() => recordMcpUsage(env, telemetry)));
    return new Response(readable, secured);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(bootstrapRegionalFeedHub(env));
    ctx.waitUntil(checkStaticSources(env, Date.now()));
    // A timetable rolled back too early comes back once the live feed has moved onto it.
    ctx.waitUntil(rollForwardSchedules(env, Date.now()));
    // The network planner's compact timetables, a bounded batch per tick.
    ctx.waitUntil(compactSchedules(env, Date.now()));
    // Every other day: check production the way an agent uses it.
    if (canaryDue(controller.scheduledTime)) ctx.waitUntil(recordCanary(env, controller.scheduledTime));
    else ctx.waitUntil(canaryRecheckDue(env, controller.scheduledTime).then(due => due ? recordCanary(env, controller.scheduledTime) : undefined));
  },
};
