import { isLegacyRequest } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';

import type { Config } from '../config';
import { loadConfig } from '../config';
import type { TelemetryInput } from '../telemetry';
import type { Env } from '../types';
import { createMetroMcpServer } from './server';

/** Anonymous MCP requests are intentionally small; 1 MiB leaves ample protocol headroom. */
export const MCP_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
const MCP_REQUEST_BODY_LIMIT_MESSAGE =
  `MCP request body exceeds ${MCP_REQUEST_BODY_LIMIT_BYTES}-byte limit`;

export type McpBodyAccumulator = {
  append: (chunk: Uint8Array) => boolean;
  bytes: () => Uint8Array;
};

/** Copy streamed bytes into one geometrically growing buffer capped at limit plus sentinel. */
export function createMcpBodyAccumulator(): McpBodyAccumulator {
  const maximumLength = MCP_REQUEST_BODY_LIMIT_BYTES + 1;
  let storage = new Uint8Array(0);
  let byteLength = 0;

  return {
    append(chunk) {
      const requiredLength = Math.min(maximumLength, byteLength + chunk.byteLength);
      if (requiredLength > storage.byteLength) {
        let capacity = Math.max(8 * 1024, storage.byteLength);
        while (capacity < requiredLength) {
          capacity = Math.min(maximumLength, capacity * 2);
        }
        const grown = new Uint8Array(capacity);
        grown.set(storage.subarray(0, byteLength));
        storage = grown;
      }

      const copiedLength = requiredLength - byteLength;
      storage.set(chunk.subarray(0, copiedLength), byteLength);
      byteLength = requiredLength;
      return byteLength <= MCP_REQUEST_BODY_LIMIT_BYTES;
    },
    bytes() {
      return storage.subarray(0, byteLength);
    },
  };
}

function requestBodyTooLargeResponse(): Response {
  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32000, message: MCP_REQUEST_BODY_LIMIT_MESSAGE },
    id: null,
  }, { status: 413 });
}

function validDeclaredBodyLength(request: Request): bigint | undefined {
  const value = request.headers.get('Content-Length');
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}

function rebuildRequestBody(request: Request, body: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  headers.set('Content-Length', String(body.byteLength));
  return new Request(request, { body, headers });
}

async function boundedMcpPostRequest(request: Request): Promise<Request | Response> {
  if (request.method.toUpperCase() !== 'POST') return request;

  const declaredLength = validDeclaredBodyLength(request);
  if (declaredLength !== undefined
    && declaredLength > BigInt(MCP_REQUEST_BODY_LIMIT_BYTES)) {
    return requestBodyTooLargeResponse();
  }

  if (request.signal.aborted) {
    if (request.body !== null) throw request.signal.reason;
    return request;
  }

  if (request.body === null) return request;

  const reader = request.body.getReader();
  const accumulator = createMcpBodyAccumulator();
  let rejectAbort: (reason?: unknown) => void = () => undefined;
  let abortCancellation: Promise<void> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const forwardAbort = () => {
    const reason = request.signal.reason;
    rejectAbort(reason);
    abortCancellation = reader.cancel(reason).catch(() => undefined);
  };
  request.signal.addEventListener('abort', forwardAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      if (!accumulator.append(value)) {
        await reader.cancel(new Error(MCP_REQUEST_BODY_LIMIT_MESSAGE)).catch(() => undefined);
        return requestBodyTooLargeResponse();
      }
    }
  } catch (error) {
    if (request.signal.aborted) {
      await abortCancellation;
      throw request.signal.reason;
    }
    throw error;
  } finally {
    request.signal.removeEventListener('abort', forwardAbort);
    reader.releaseLock();
  }

  return rebuildRequestBody(request, accumulator.bytes());
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

function linkMcpRequestSignal(
  request: Request,
  sourceSignal: AbortSignal = request.signal,
): LinkedMcpRequest {
  const controller = new AbortController();
  let listening = false;
  const forwardAbort = () => controller.abort(sourceSignal.reason);

  if (sourceSignal.aborted) {
    forwardAbort();
  } else {
    sourceSignal.addEventListener('abort', forwardAbort, { once: true });
    listening = true;
  }

  return {
    request: new Request(request, { signal: controller.signal }),
    controller,
    cleanup() {
      if (listening) {
        listening = false;
        sourceSignal.removeEventListener('abort', forwardAbort);
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

/** Serve one anonymous stateless MCP request. */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  config: Config = loadConfig(env),
  telemetry?: TelemetryInput,
): Promise<Response> {
  const bounded = await boundedMcpPostRequest(request);
  if (bounded instanceof Response) return bounded;

  const missingVersion = await missingModernVersionHeaderResponse(bounded);
  if (missingVersion) {
    return missingVersion;
  }

  const handler = createMcpHandler(
    sdkContext => {
      if (telemetry) {
        telemetry.era = sdkContext.era;
        if (sdkContext.era === 'modern') {
          telemetry.protocolVersion = bounded.headers.get('MCP-Protocol-Version') ?? undefined;
          telemetry.mcpMethod = bounded.headers.get('Mcp-Method') ?? undefined;
          telemetry.mcpName = bounded.headers.get('Mcp-Name') ?? undefined;
        }
      }
      return createMetroMcpServer({
        env,
        era: sdkContext.era,
      });
    },
    {
      route: '/mcp',
      legacy: 'stateless',
      responseMode: 'auto',
      allowedHostnames: config.mcp.allowedHostnames,
      allowedOriginHostnames: config.mcp.allowedOriginHostnames,
    },
  );

  const headers = new Headers(bounded.headers);
  headers.delete('Authorization');
  const anonymousRequest = new Request(bounded, { headers });
  const linked = linkMcpRequestSignal(anonymousRequest, request.signal);
  let response: Response;
  try {
    response = await handler.fetch(linked.request);
  } catch (error) {
    linked.cleanup();
    throw error;
  }
  return bridgeResponseCancellation(response, linked.controller, linked.cleanup);
}
