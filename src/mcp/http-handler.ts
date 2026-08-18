import { isLegacyRequest, type AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';

import type { Config } from '../config';
import { loadConfig } from '../config';
import type { TelemetryInput } from '../telemetry';
import type { Env } from '../types';
import { parseMetroMcpProps, requireTransitRead } from './context';
import { createMetroMcpServer } from './server';

function insufficientScope(): Response {
  return Response.json(
    {
      error: 'insufficient_scope',
      error_description: 'The transit:read scope is required.',
    },
    {
      status: 403,
      headers: {
        'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="transit:read"',
      },
    },
  );
}

async function missingModernVersionHeaderResponse(
  request: Request,
): Promise<Response | undefined> {
  if (request.headers.has('MCP-Protocol-Version') || await isLegacyRequest(request)) {
    return undefined;
  }

  let id: string | number | null = null;
  try {
    const body: unknown = await request.clone().json();
    if (body && typeof body === 'object' && !Array.isArray(body) && 'id' in body) {
      const candidate = body.id;
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        id = candidate;
      }
    }
  } catch {
    // The SDK classifier already identified a modern envelope; keep a null ID
    // if its request body cannot be safely read again.
  }

  return Response.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32020,
        message: 'The MCP-Protocol-Version header is required for MCP 2026 requests.',
      },
      id,
    },
    { status: 400 },
  );
}

type LinkedMcpRequest = {
  request: Request;
  controller: AbortController;
  cleanup: () => void;
};

function linkMcpRequestSignal(request: Request): LinkedMcpRequest {
  const controller = new AbortController();
  let listening = false;
  const forwardAbort = () => controller.abort(request.signal.reason);

  if (request.signal.aborted) {
    forwardAbort();
  } else {
    request.signal.addEventListener('abort', forwardAbort, { once: true });
    listening = true;
  }

  return {
    request: new Request(request, { signal: controller.signal }),
    controller,
    cleanup() {
      if (listening) {
        listening = false;
        request.signal.removeEventListener('abort', forwardAbort);
      }
    },
  };
}

function bridgeResponseCancellation(
  response: Response,
  controller: AbortController,
  cleanup: () => void,
): Response {
  if (!response.body) {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      cleanup();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          streamController.close();
        } else if (value !== undefined) {
          streamController.enqueue(value);
        }
      } catch (error) {
        finish();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
      finish();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Serve one authenticated stateless MCP request from Provider-owned props. */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  authInfo: AuthInfo | undefined,
  rawProps: unknown,
  config: Config = loadConfig(env),
  telemetry?: TelemetryInput,
): Promise<Response> {
  let props;
  try {
    props = requireTransitRead(parseMetroMcpProps(rawProps));
  } catch {
    return insufficientScope();
  }

  if (telemetry) {
    telemetry.clientId = props.clientId;
  }

  const missingVersion = await missingModernVersionHeaderResponse(request);
  if (missingVersion) {
    return missingVersion;
  }

  const handler = createMcpHandler(
    sdkContext => {
      if (telemetry) {
        telemetry.era = sdkContext.era;
        if (sdkContext.era === 'modern') {
          telemetry.protocolVersion = request.headers.get('MCP-Protocol-Version') ?? undefined;
          telemetry.mcpMethod = request.headers.get('Mcp-Method') ?? undefined;
          telemetry.mcpName = request.headers.get('Mcp-Name') ?? undefined;
        }
      }
      return createMetroMcpServer({
        env,
        era: sdkContext.era,
        authInfo: sdkContext.authInfo,
        props,
      });
    },
    {
      route: '/mcp',
      legacy: 'stateless',
      responseMode: 'auto',
      allowedHostnames: config.mcp.allowedHostnames,
      allowedOriginHostnames: config.mcp.allowedOriginHostnames,
      authContext: { props },
    },
  );

  const linked = linkMcpRequestSignal(request);
  let response: Response;
  try {
    response = await handler.fetch(
      linked.request,
      authInfo ? { authInfo } : undefined,
    );
  } catch (error) {
    linked.cleanup();
    throw error;
  }
  return bridgeResponseCancellation(response, linked.controller, linked.cleanup);
}
