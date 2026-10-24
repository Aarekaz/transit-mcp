import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mcp-agent', () => ({
  MetroMcpAgent: class {
    static serve(): never {
      throw new Error('public route characterization reached the legacy MCP agent');
    }
  },
}));

import worker from '../../src/index';
import { createMockEnv } from '../setup';

function executionContext(): ExecutionContext {
  return {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('public route characterization', () => {
  it('delegates GET / to the static asset binding without changing the response', async () => {
    const assetResponse = new Response('<!doctype html><title>Metro MCP</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    const assetFetch = vi.fn().mockResolvedValue(assetResponse);
    const env = createMockEnv({ ASSETS: { fetch: assetFetch } as unknown as Fetcher });
    const request = new Request('https://metro-mcp.anuragd.me/');

    const response = await worker.fetch(request, env, executionContext());

    expect(assetFetch).toHaveBeenCalledWith(request);
    expect(await response.text()).toContain('<title>Metro MCP</title>');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('answers a byte range of the link-preview video with 206, as Apple players require', async () => {
    const video = () => new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { headers: { 'Content-Type': 'video/mp4' } });
    const env = createMockEnv({ ASSETS: { fetch: vi.fn(async () => video()) } as unknown as Fetcher });
    const get = (range?: string) => worker.fetch(new Request('https://transitmcp.com/og-video.mp4', range ? { headers: { Range: range } } : {}), env, executionContext());

    const probe = await get('bytes=0-1');
    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe('bytes 0-1/10');
    expect([...new Uint8Array(await probe.arrayBuffer())]).toEqual([0, 1]);
    const rest = await get('bytes=7-');
    expect(rest.headers.get('content-range')).toBe('bytes 7-9/10');
    expect([...new Uint8Array(await rest.arrayBuffer())]).toEqual([7, 8, 9]);
    const tail = await get('bytes=-3');
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([7, 8, 9]);
    expect((await get('bytes=20-')).status).toBe(416);
    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect((await whole.arrayBuffer()).byteLength).toBe(10);
  });

  it('serves the structured server description at GET /info', async () => {
    const env = createMockEnv();

    const response = await worker.fetch(
      new Request('https://metro-mcp.anuragd.me/info'),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    await expect(response.json()).resolves.toMatchObject({
      name: 'Transit MCP',
      links: { mcpServer: 'https://metro-mcp.anuragd.me/mcp' },
      endpoints: { mcpRecommended: '/mcp' },
    });
  });

  it('serves the exact OpenAI domain-verification token without using static assets', async () => {
    const assetFetch = vi.fn();
    const env = createMockEnv({ ASSETS: { fetch: assetFetch } as unknown as Fetcher });

    const response = await worker.fetch(
      new Request('https://metro-mcp.anuragd.me/.well-known/openai-apps-challenge'),
      env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
    expect(await response.text()).toBe('A4dphR5uRWU44rm5ytkVkwHt8wj3aJmxoRja8nLMnsg');
    expect(assetFetch).not.toHaveBeenCalled();
  });

  it('delegates every unmatched GET asset path and rejects unmatched writes', async () => {
    const assetFetch = vi.fn().mockResolvedValue(new Response('asset', { status: 203 }));
    const env = createMockEnv({ ASSETS: { fetch: assetFetch } as unknown as Fetcher });
    const ctx = executionContext();
    const assetRequest = new Request('https://metro-mcp.anuragd.me/docs/index.html');

    const assetResponse = await worker.fetch(assetRequest, env, ctx);
    const writeResponse = await worker.fetch(
      new Request('https://metro-mcp.anuragd.me/docs/index.html', { method: 'POST' }),
      env,
      ctx,
    );

    expect(assetFetch).toHaveBeenCalledWith(assetRequest);
    expect(assetResponse.status).toBe(203);
    expect(assetResponse.headers.get('x-frame-options')).toBe('DENY');
    expect(writeResponse.status).toBe(404);
    expect(await writeResponse.text()).toBe('Not Found');
    expect(writeResponse.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each([
    ['GET', '/authorize'],
    ['POST', '/authorize/decision'],
    ['GET', '/callback'],
    ['POST', '/token'],
    ['POST', '/register'],
    ['GET', '/.well-known/oauth-authorization-server'],
    ['GET', '/.well-known/oauth-protected-resource'],
    ['GET', '/.well-known/oauth-protected-resource/mcp'],
  ])('returns 404 for former OAuth endpoint %s %s', async (method, pathname) => {
    const env = createMockEnv({
      ASSETS: { fetch: vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })) } as unknown as Fetcher,
    });

    const response = await worker.fetch(
      new Request(`https://metro-mcp.anuragd.me${pathname}`, { method }),
      env,
      executionContext(),
    );

    expect(response.status).toBe(404);
  });
});
