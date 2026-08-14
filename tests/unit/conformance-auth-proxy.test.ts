import { describe, expect, it } from 'vitest';
import {
  createConformanceProxyHandler,
  loadConformanceProxyOptions,
  requireAbsoluteHttpUrl,
} from '../../scripts/conformance-auth-proxy';

describe('authenticated conformance proxy', () => {
  it.each([
    'https://preview.example.test/mcp',
    'http://10.0.0.5:8787/mcp',
    'http://169.254.169.254/latest/meta-data',
  ])('rejects a non-loopback target unless remote access is explicit: %s', target => {
    expect(() => requireAbsoluteHttpUrl(target, false)).toThrow('non-loopback');
    expect(requireAbsoluteHttpUrl(target, true).href).toBe(target);
  });

  it('requires a target and token without disclosing either value', () => {
    expect(() => loadConformanceProxyOptions({})).toThrow('MCP_CONFORMANCE_TARGET_URL');
    expect(() => loadConformanceProxyOptions({
      MCP_CONFORMANCE_TARGET_URL: 'http://127.0.0.1:8787/mcp',
    })).toThrow('MCP_CONFORMANCE_TOKEN');
  });

  it('replaces inbound authorization and preserves method, body, path, query, and safe headers', async () => {
    const observed: {
      method?: string;
      url?: string;
      authorization?: string;
      contentType?: string;
      trace?: string;
      body?: string;
    } = {};
    const fetchUpstream = async (request: Request): Promise<Response> => {
      observed.method = request.method;
      observed.url = new URL(request.url).pathname + new URL(request.url).search;
      observed.authorization = request.headers.get('authorization') ?? undefined;
      observed.contentType = request.headers.get('content-type') ?? undefined;
      observed.trace = request.headers.get('x-test-trace') ?? undefined;
      observed.body = await request.text();
      return Response.json({ ok: true });
    };
    const handler = createConformanceProxyHandler(
      new URL('http://127.0.0.1:8787/configured-path'),
      'operator-short-lived-token',
      fetchUpstream,
    );

    const response = await handler(new Request('http://127.0.0.1:8788/mcp?case=modern', {
      method: 'POST',
      headers: {
        authorization: 'Bearer attacker-controlled',
        'content-type': 'application/json',
        'x-test-trace': 'preserved',
      },
      body: '{"jsonrpc":"2.0"}',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(observed).toEqual({
      method: 'POST',
      url: '/mcp?case=modern',
      authorization: 'Bearer operator-short-lived-token',
      contentType: 'application/json',
      trace: 'preserved',
      body: '{"jsonrpc":"2.0"}',
    });
  });

  it('serves health locally without contacting the target', async () => {
    let upstreamRequests = 0;
    const handler = createConformanceProxyHandler(
      new URL('http://127.0.0.1:8787/mcp'),
      'operator-short-lived-token',
      async () => {
        upstreamRequests += 1;
        return new Response('unexpected');
      },
    );

    const response = await handler(new Request('http://127.0.0.1:8788/health'));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(upstreamRequests).toBe(0);
  });

  it('does not advertise compression after fetch has decoded the upstream body', async () => {
    let upstreamAcceptEncoding: string | null = null;
    const handler = createConformanceProxyHandler(
      new URL('http://127.0.0.1:8787/mcp'),
      'operator-short-lived-token',
      async request => {
        upstreamAcceptEncoding = request.headers.get('accept-encoding');
        return new Response('{"ok":true}', {
          headers: {
            'content-encoding': 'gzip',
            'content-length': '31',
            'content-type': 'application/json',
          },
        });
      },
    );

    const response = await handler(new Request('http://127.0.0.1:8788/mcp', {
      headers: { 'accept-encoding': 'gzip, deflate' },
    }));

    expect(upstreamAcceptEncoding).toBe('identity');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  it('uses manual redirects and never follows a cross-origin location', async () => {
    let upstreamRequests = 0;
    let redirectMode: string | undefined;
    const handler = createConformanceProxyHandler(
      new URL('http://127.0.0.1:8787/mcp'),
      'operator-short-lived-token',
      async request => {
        upstreamRequests += 1;
        redirectMode = request.redirect;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/collect' },
        });
      },
    );

    const response = await handler(new Request('http://127.0.0.1:8788/mcp'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://attacker.example/collect');
    expect(upstreamRequests).toBe(1);
    expect(redirectMode).toBe('manual');
  });

  it('returns a redacted gateway error when forwarding fails', async () => {
    const token = 'operator-token-that-must-not-escape';
    const handler = createConformanceProxyHandler(
      new URL('http://127.0.0.1:1/mcp'),
      token,
      async () => {
        throw new Error(`connect failed while using ${token}`);
      },
    );

    const response = await handler(new Request('http://127.0.0.1:8788/mcp'));
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toBe('Bad Gateway');
    expect(body).not.toContain(token);
    expect([...response.headers]).not.toContainEqual(expect.arrayContaining([token]));
  });
});
