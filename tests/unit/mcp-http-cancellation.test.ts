import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlerFetch = vi.fn<(request: Request) => Promise<Response>>();

vi.mock('agents/mcp/server', () => ({
  createMcpHandler: vi.fn(() => ({ fetch: handlerFetch })),
}));

vi.mock('../../src/mcp/server', () => ({
  createMetroMcpServer: vi.fn(),
}));

import { handleMcpRequest } from '../../src/mcp/http-handler';
import { createMockEnv } from '../setup';

const props = {
  userId: '42',
  userLogin: 'workerd-user',
  clientId: 'client-42',
  scopes: ['transit:read'] as ['transit:read'],
};

beforeEach(() => {
  handlerFetch.mockReset();
});

describe('MCP response cancellation bridge', () => {
  it('aborts the handler request with the exact response cancellation reason', async () => {
    let handlerSignal: AbortSignal | undefined;
    let delegatedReason: unknown;
    handlerFetch.mockImplementation(async request => {
      handlerSignal = request.signal;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message\n\n'));
        },
        cancel(reason) {
          delegatedReason = reason;
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    });

    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', { method: 'POST' }),
      createMockEnv(),
      undefined,
      props,
    );
    const reader = response.body!.getReader();
    await reader.read();
    const reason = { source: 'reader.cancel' };
    await reader.cancel(reason);

    expect(handlerSignal?.aborted).toBe(true);
    expect(handlerSignal?.reason).toBe(reason);
    expect(delegatedReason).toBe(reason);
  });

  it('passes an already-aborted incoming reason to the handler request', async () => {
    const controller = new AbortController();
    const reason = { source: 'incoming request' };
    controller.abort(reason);
    handlerFetch.mockImplementation(async request => {
      expect(request.signal.aborted).toBe(true);
      expect(request.signal.reason).toBe(reason);
      return new Response(null, { status: 499 });
    });

    const response = await handleMcpRequest(
      new Request('https://metro-mcp.anuragd.me/mcp', {
        method: 'POST',
        signal: controller.signal,
      }),
      createMockEnv(),
      undefined,
      props,
    );

    expect(response.status).toBe(499);
  });

  it('cleans up after normal EOF without spuriously aborting the handler request', async () => {
    let handlerSignal: AbortSignal | undefined;
    const incoming = new AbortController();
    const request = new Request('https://metro-mcp.anuragd.me/mcp', {
      method: 'POST',
      signal: incoming.signal,
    });
    const remove = vi.spyOn(request.signal, 'removeEventListener');
    handlerFetch.mockImplementation(async request => {
      handlerSignal = request.signal;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('done'));
          controller.close();
        },
      }));
    });

    const response = await handleMcpRequest(
      request,
      createMockEnv(),
      undefined,
      props,
    );

    await expect(response.text()).resolves.toBe('done');
    expect(handlerSignal?.aborted).toBe(false);
    expect(remove).toHaveBeenCalled();
  });

  it('removes the incoming abort listener when the handler rejects', async () => {
    const incoming = new AbortController();
    const request = new Request('https://metro-mcp.anuragd.me/mcp', {
      method: 'POST',
      signal: incoming.signal,
    });
    const remove = vi.spyOn(request.signal, 'removeEventListener');
    handlerFetch.mockRejectedValue(new Error('handler failed'));

    await expect(handleMcpRequest(
      request,
      createMockEnv(),
      undefined,
      props,
    )).rejects.toThrow('handler failed');
    expect(remove).toHaveBeenCalled();
  });
});
