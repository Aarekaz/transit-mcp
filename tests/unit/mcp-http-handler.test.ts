import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlerFetch = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());

vi.mock('agents/mcp/server', () => ({
  createMcpHandler: vi.fn(() => ({ fetch: handlerFetch })),
}));

vi.mock('../../src/mcp/server', () => ({
  createMetroMcpServer: vi.fn(),
}));

import {
  createMcpBodyAccumulator,
  handleMcpRequest,
} from '../../src/mcp/http-handler';
import { addSecurityHeadersAuto } from '../../src/middleware/security-headers';
import { createMockEnv } from '../setup';

const MCP_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;

function streamingPostRequest(
  body: ReadableStream<Uint8Array>,
  contentLength?: string,
  signal?: AbortSignal,
): Request {
  const headers = new Headers({
    Host: 'metro-mcp.anuragd.me',
    Authorization: 'Bearer stale-canary',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'server/discover',
  });
  if (contentLength !== undefined) headers.set('Content-Length', contentLength);
  return new Request('https://metro-mcp.anuragd.me/mcp', {
    method: 'POST',
    headers,
    body,
    signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

function exactLengthModernBody(byteLength: number): string {
  const envelope = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {},
  });
  if (envelope.length > byteLength) throw new Error('requested body is too small');
  return envelope + ' '.repeat(byteLength - envelope.length);
}

beforeEach(() => {
  handlerFetch.mockReset();
});

describe('handleMcpRequest', () => {
  it('serves anonymous preflight without Provider props or an authentication challenge', async () => {
    handlerFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'OPTIONS',
        headers: { Host: 'metro-mcp.anuragd.me' },
      }),
      createMockEnv(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.has('www-authenticate')).toBe(false);
  });

  it('removes a stale Authorization header before SDK dispatch', async () => {
    handlerFetch.mockResolvedValueOnce(Response.json({ result: { ok: true } }));
    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'POST',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Authorization: 'Bearer canary-do-not-log',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'server/discover',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
      }),
      createMockEnv(),
    );

    expect(response.status).toBe(200);
    expect(handlerFetch).toHaveBeenCalledOnce();
    expect(handlerFetch.mock.calls[0]![0].headers.has('authorization')).toBe(false);
  });

  it('rejects the reproduced 16.8 MB declared body before reading or SDK dispatch', async () => {
    let pulled = false;
    const body = new ReadableStream({
      type: 'bytes',
      pull() {
        pulled = true;
      },
    } as UnderlyingByteSource);

    const response = await handleMcpRequest(
      streamingPostRequest(body, '16777477'),
      createMockEnv(),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'MCP request body exceeds 1048576-byte limit' },
      id: null,
    });
    expect(pulled).toBe(false);
    expect(handlerFetch).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body even when the request is already aborted', async () => {
    const incoming = new AbortController();
    incoming.abort(new DOMException('client disconnected', 'AbortError'));
    let pulled = false;
    const body = new ReadableStream({
      type: 'bytes',
      pull() {
        pulled = true;
      },
    } as UnderlyingByteSource);
    handlerFetch.mockResolvedValueOnce(Response.json({ result: { reachedSdk: true } }));

    const response = await handleMcpRequest(
      streamingPostRequest(body, '16777477', incoming.signal),
      createMockEnv(),
    );

    expect(response.status).toBe(413);
    expect(pulled).toBe(false);
    expect(handlerFetch).not.toHaveBeenCalled();
  });

  it('does not dispatch an already-aborted streamed body with no declared length', async () => {
    const incoming = new AbortController();
    const reason = new DOMException('client disconnected', 'AbortError');
    incoming.abort(reason);
    let pulled = false;
    const body = new ReadableStream({
      type: 'bytes',
      pull() {
        pulled = true;
      },
    } as UnderlyingByteSource);
    handlerFetch.mockResolvedValueOnce(Response.json({ result: { reachedSdk: true } }));

    await expect(handleMcpRequest(
      streamingPostRequest(body, undefined, incoming.signal),
      createMockEnv(),
    )).rejects.toBe(reason);
    expect(pulled).toBe(false);
    expect(handlerFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['invalid', 'invalid'],
    ['ambiguous', '1, 2'],
  ])('bounds and cancels a streamed overflow with %s Content-Length', async (_name, length) => {
    let offset = 0;
    let cancelReason: unknown;
    const body = new ReadableStream({
      type: 'bytes',
      pull(controller) {
        const chunkLength = Math.min(256 * 1024, MCP_REQUEST_BODY_LIMIT_BYTES + 1 - offset);
        controller.enqueue(new Uint8Array(chunkLength));
        offset += chunkLength;
      },
      cancel(reason) {
        cancelReason = reason;
      },
    } as UnderlyingByteSource);

    const response = await handleMcpRequest(
      streamingPostRequest(body, length),
      createMockEnv(),
    );

    expect(response.status).toBe(413);
    expect(offset).toBe(MCP_REQUEST_BODY_LIMIT_BYTES + 1);
    expect(cancelReason).toBeInstanceOf(Error);
    expect(handlerFetch).not.toHaveBeenCalled();
  });

  it('grows the bounded backing buffer geometrically across very many tiny chunks', () => {
    const accumulator = createMcpBodyAccumulator();
    const oneByte = new Uint8Array([0x61]);
    let allAccepted = true;
    let backing = accumulator.bytes().buffer;
    let growthCount = 0;

    for (let index = 0; index < 300_000; index += 1) {
      allAccepted = accumulator.append(oneByte) && allAccepted;
      const currentBacking = accumulator.bytes().buffer;
      if (currentBacking !== backing) {
        backing = currentBacking;
        growthCount += 1;
      }
    }

    expect(allAccepted).toBe(true);
    expect(growthCount).toBeLessThan(32);
    expect(accumulator.bytes().byteLength).toBe(300_000);
    expect(accumulator.append(new Uint8Array(MCP_REQUEST_BODY_LIMIT_BYTES + 1 - 300_000)))
      .toBe(false);
    expect(accumulator.bytes().byteLength).toBe(MCP_REQUEST_BODY_LIMIT_BYTES + 1);
  });

  it('does not reserve the full request limit before body bytes arrive', () => {
    const accumulator = createMcpBodyAccumulator();

    expect(accumulator.bytes().byteLength).toBe(0);
    expect(accumulator.bytes().buffer.byteLength).toBeLessThan(64 * 1024);
  });

  it('rebuilds an exactly-at-limit request for anonymous SDK dispatch', async () => {
    handlerFetch.mockImplementationOnce(async request => {
      expect(request.headers.get('content-length')).toBe(String(MCP_REQUEST_BODY_LIMIT_BYTES));
      expect(request.headers.has('authorization')).toBe(false);
      expect((await request.text()).length).toBe(MCP_REQUEST_BODY_LIMIT_BYTES);
      return Response.json({ result: { ok: true } });
    });
    const body = exactLengthModernBody(MCP_REQUEST_BODY_LIMIT_BYTES);

    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'POST',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Authorization: 'Bearer stale-canary',
          'Content-Type': 'application/json',
          'Content-Length': String(MCP_REQUEST_BODY_LIMIT_BYTES),
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'server/discover',
        },
        body,
      }),
      createMockEnv(),
    );

    expect(response.status).toBe(200);
    expect(handlerFetch).toHaveBeenCalledOnce();
  });

  it('preserves an incoming abort reason while reading and removes its listener', async () => {
    const incoming = new AbortController();
    let pullStarted = false;
    let cancelReason: unknown;
    let releasePull: (() => void) | undefined;
    const body = new ReadableStream({
      type: 'bytes',
      pull() {
        pullStarted = true;
        return new Promise<void>(resolve => {
          releasePull = resolve;
        });
      },
      cancel(reason) {
        cancelReason = reason;
        releasePull?.();
      },
    } as UnderlyingByteSource);
    const request = streamingPostRequest(body, undefined, incoming.signal);
    const remove = vi.spyOn(request.signal, 'removeEventListener');
    const pending = handleMcpRequest(request, createMockEnv());
    await vi.waitFor(() => expect(pullStarted).toBe(true));
    const reason = { source: 'bounded body reader' };

    incoming.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancelReason).toBe(reason);
    expect(remove).toHaveBeenCalled();
    expect(handlerFetch).not.toHaveBeenCalled();
  });

  it('keeps the Agents modern MCP preflight policy through outer security composition', async () => {
    handlerFetch.mockResolvedValueOnce(new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
      },
    }));
    const mcpResponse = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'OPTIONS',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Origin: 'https://metro-mcp.anuragd.me',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        },
      }),
      createMockEnv(),
    );

    const response = addSecurityHeadersAuto(mcpResponse);
    const allowedHeaders = response.headers.get('access-control-allow-headers') ?? '';

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-methods'))
      .toBe('GET, POST, DELETE, OPTIONS');
    expect(allowedHeaders).toContain('MCP-Protocol-Version');
    expect(allowedHeaders).toContain('Mcp-Method');
    expect(allowedHeaders).toContain('Mcp-Name');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves an ordinary legacy stateless request without an authorization object', async () => {
    handlerFetch.mockResolvedValueOnce(new Response('{"id":1}'));
    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'POST',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
      createMockEnv(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"id":1');
  });
});
