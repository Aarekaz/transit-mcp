import { createExecutionContext, SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../../src/index';

import {
  legacyMcpRequest,
  modernEnvelope,
  modernMcpRequest,
  readMcpResponse,
  TEST_ORIGIN,
} from '../helpers/mcp-request';
import {
  EXPECTED_PROMPT_NAMES,
  EXPECTED_RESOURCE_NAMES,
  EXPECTED_TOOL_NAMES,
  TRANSIT_BOARD_MIME,
  TRANSIT_BOARD_RESOURCE_CONTRACT,
  TRANSIT_BOARD_RESOURCE_META,
  TRANSIT_BOARD_TOOL_META,
  TRANSIT_BOARD_URI,
} from '../fixtures/mcp-contracts';

const RATE_LIMIT_PERIOD_MS = 10_000;
let nextTestClient = 1;

function workerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const pathname = new URL(request.url).pathname;
  if (
    request.method === 'POST'
    && (pathname === '/mcp' || pathname === '/sse')
    && !request.headers.has('CF-Connecting-IP')
  ) {
    request.headers.set('CF-Connecting-IP', `198.51.100.${nextTestClient++}`);
  }
  return SELF.fetch(request);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function enterFreshRateLimitEpoch(): Promise<number> {
  while (true) {
    const now = Date.now();
    const nextEpochAt = now - (now % RATE_LIMIT_PERIOD_MS) + RATE_LIMIT_PERIOD_MS;
    await sleep(nextEpochAt - now + 25);
    const enteredAt = Date.now();
    const remaining = RATE_LIMIT_PERIOD_MS - (enteredAt % RATE_LIMIT_PERIOD_MS);
    if (remaining >= RATE_LIMIT_PERIOD_MS / 2) {
      return Math.floor(enteredAt / RATE_LIMIT_PERIOD_MS);
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function onlyResult(messages: unknown[]): Record<string, unknown> {
  expect(messages).toHaveLength(1);
  return record(record(messages[0]).result);
}

function failUnmatchedFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    throw new Error(`Unmatched outbound request: ${new Request(input).url}`);
  });
}

beforeEach(() => {
  failUnmatchedFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assembled MCP Worker', () => {
  it('serves anonymous modern server/discover without an authentication challenge', async () => {
    const response = await workerFetch(await modernMcpRequest('server/discover'));

    expect(response.status).toBe(200);
    expect(response.headers.has('www-authenticate')).toBe(false);
  });

  it('serves modern server/discover without initialize', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await workerFetch(await modernMcpRequest('server/discover'));
    const messages = await readMcpResponse(response);

    expect(response.status).toBe(200);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        resultType: 'complete',
        ttlMs: 86_400_000,
        cacheScope: 'public',
        supportedVersions: ['2026-07-28'],
        capabilities: {
          extensions: {
            'io.modelcontextprotocol/ui': {
              mimeTypes: [TRANSIT_BOARD_MIME],
            },
          },
          tools: {},
          prompts: {},
          resources: {},
        },
      },
    });
  });

  it('exposes exactly 13 tools, 3 resource templates, and 3 prompts with modern cache hints', async () => {
    const [toolsResponse, resourcesResponse, promptsResponse] = await Promise.all([
      workerFetch(await modernMcpRequest('tools/list')),
      workerFetch(await modernMcpRequest('resources/templates/list')),
      workerFetch(await modernMcpRequest('prompts/list')),
    ]);

    const tools = onlyResult(await readMcpResponse(toolsResponse));
    const resources = onlyResult(await readMcpResponse(resourcesResponse));
    const prompts = onlyResult(await readMcpResponse(promptsResponse));

    expect((tools.tools as Array<{ name: string }>).map(tool => tool.name))
      .toEqual(EXPECTED_TOOL_NAMES);
    for (const tool of tools.tools as Array<{ _meta?: unknown }>) {
      expect(tool._meta).toEqual(TRANSIT_BOARD_TOOL_META);
    }
    expect((resources.resourceTemplates as Array<{ name: string }>).map(item => item.name))
      .toEqual(EXPECTED_RESOURCE_NAMES);
    expect((prompts.prompts as Array<{ name: string }>).map(prompt => prompt.name))
      .toEqual(EXPECTED_PROMPT_NAMES);
    for (const result of [tools, resources, prompts]) {
      expect(result).toMatchObject({
        resultType: 'complete',
        ttlMs: 86_400_000,
        cacheScope: 'public',
      });
    }
  });

  it('lists and reads the committed Transit Board asset through anonymous MCP', async () => {
    const publicAssetResponse = await workerFetch(`${TEST_ORIGIN}/apps/transit-board.html`, {
      headers: { Host: 'metro-mcp.anuragd.me' },
    });
    const [listResponse, readResponse] = await Promise.all([
      workerFetch(await modernMcpRequest('resources/list')),
      workerFetch(await modernMcpRequest('resources/read', { uri: TRANSIT_BOARD_URI })),
    ]);
    const listed = onlyResult(await readMcpResponse(listResponse));
    const read = onlyResult(await readMcpResponse(readResponse));
    const publicHtml = await publicAssetResponse.text();

    expect(publicAssetResponse.status).toBe(200);
    expect(publicHtml).toMatch(/^<!doctype html>/i);
    expect(new TextEncoder().encode(publicHtml).byteLength).toBeLessThanOrEqual(1_048_576);
    expect((listed.resources as unknown[])[0]).toEqual({
      uri: TRANSIT_BOARD_URI,
      name: TRANSIT_BOARD_RESOURCE_CONTRACT.name,
      mimeType: TRANSIT_BOARD_MIME,
      _meta: TRANSIT_BOARD_RESOURCE_META,
    });
    expect(read).toEqual({
      resultType: 'complete',
      ttlMs: 86_400_000,
      cacheScope: 'public',
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'metro-mcp',
          version: '5.0.0',
        },
      },
      contents: [{
        uri: TRANSIT_BOARD_URI,
        mimeType: TRANSIT_BOARD_MIME,
        text: publicHtml,
        _meta: TRANSIT_BOARD_RESOURCE_META,
      }],
    });
  });

  it('serves Transit Board resource reads without a token', async () => {
    const request = new Request(`${TEST_ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        Host: 'metro-mcp.anuragd.me',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'resources/read',
        'Mcp-Name': TRANSIT_BOARD_URI,
      },
      body: JSON.stringify(modernEnvelope('resources/read', { uri: TRANSIT_BOARD_URI })),
    });

    const response = await workerFetch(request);

    expect(response.status).toBe(200);
    expect(response.headers.has('www-authenticate')).toBe(false);
  });

  it('serves representative modern tool, resource, and prompt calls', async () => {
    const [toolResponse, resourceResponse, promptResponse] = await Promise.all([
      workerFetch(await modernMcpRequest('tools/call', {
        name: 'search_stations',
        arguments: { city: 'nyc', query: 'Times Sq' },
      })),
      workerFetch(await modernMcpRequest('resources/read', {
        uri: 'transit://stations/nyc/127',
      })),
      workerFetch(await modernMcpRequest('prompts/get', {
        name: 'service-briefing',
        arguments: { city: 'dc' },
      })),
    ]);

    const tool = onlyResult(await readMcpResponse(toolResponse));
    const resource = onlyResult(await readMcpResponse(resourceResponse));
    const prompt = onlyResult(await readMcpResponse(promptResponse));

    expect(tool).toMatchObject({
      resultType: 'complete',
      structuredContent: { city: 'nyc', query: 'Times Sq' },
    });
    const structuredContent = record(tool.structuredContent);
    expect(tool.content).toEqual([{
      type: 'text',
      text: JSON.stringify(structuredContent),
    }]);
    expect(tool).not.toHaveProperty('ttlMs');
    expect(resource).toMatchObject({
      resultType: 'complete',
      ttlMs: 86_400_000,
      cacheScope: 'public',
    });
    expect(record((resource.contents as unknown[])[0])).toMatchObject({
      uri: 'transit://stations/nyc/127',
      mimeType: 'application/json',
    });
    expect(prompt).toMatchObject({ resultType: 'complete' });
    expect(prompt).not.toHaveProperty('ttlMs');
  });

  it('keeps ordinary 2025 stateless list/call behavior and legacy ambiguity guidance', async () => {
    const [listResponse, callResponse, ambiguousResponse] = await Promise.all([
      workerFetch(await legacyMcpRequest('tools/list')),
      workerFetch(await legacyMcpRequest('tools/call', {
        name: 'search_stations',
        arguments: { city: 'nyc', query: 'Times Sq' },
      })),
      workerFetch(await legacyMcpRequest('tools/call', {
        name: 'get_station_predictions',
        arguments: { city: 'nyc', stationName: 'Broadway' },
      })),
    ]);

    const list = onlyResult(await readMcpResponse(listResponse));
    const call = onlyResult(await readMcpResponse(callResponse));
    const ambiguous = onlyResult(await readMcpResponse(ambiguousResponse));
    expect((list.tools as Array<{ name: string }>).map(tool => tool.name))
      .toEqual(EXPECTED_TOOL_NAMES);
    for (const tool of list.tools as Array<{ _meta?: unknown }>) {
      expect(tool._meta).toEqual(TRANSIT_BOARD_TOOL_META);
    }
    expect(call).toMatchObject({ structuredContent: { city: 'nyc', query: 'Times Sq' } });
    expect(call.content).toEqual([{
      type: 'text',
      text: JSON.stringify(record(call.structuredContent)),
    }]);
    expect(ambiguous).toMatchObject({ isError: true });
    expect(JSON.stringify(ambiguous)).toContain('please call get_station_predictions again');
  });

  it('keeps /sse as an exact POST alias and rejects unsupported MCP methods before dispatch', async () => {
    const aliasResponse = await workerFetch(await modernMcpRequest(
      'server/discover',
      {},
      { path: '/sse' },
    ));
    expect(aliasResponse.status).toBe(200);

    for (const [path, method] of [
      ['/mcp', 'GET'],
      ['/mcp', 'DELETE'],
      ['/mcp/', 'POST'],
      ['/mcp/tools', 'POST'],
      ['/sse', 'GET'],
      ['/sse', 'DELETE'],
      ['/sse/', 'POST'],
      ['/sse/events', 'POST'],
    ] as const) {
      const response = await workerFetch(`${TEST_ORIGIN}${path}`, {
        method,
        headers: { Host: 'metro-mcp.anuragd.me' },
      });
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    }
  });

  it('does not create an authentication path for query-string credentials', async () => {
    for (const query of ['access_token=not-a-token', 'token=not-a-token']) {
      const request = await modernMcpRequest('server/discover');
      const url = new URL(request.url);
      url.search = query;
      const response = await workerFetch(new Request(url, request));
      expect(response.status).toBe(200);
      expect(response.headers.has('www-authenticate')).toBe(false);
    }
  });

  it('returns SDK-defined errors for version, method, and name mismatches', async () => {
    const cases = [
      new Request(`${TEST_ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      new Request(`${TEST_ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          Host: 'metro-mcp.anuragd.me',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'MCP-Protocol-Version': '2025-11-25',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify(modernEnvelope('tools/list')),
      }),
      await modernMcpRequest('tools/list'),
      await modernMcpRequest('tools/call', {
        name: 'search_stations',
        arguments: { city: 'nyc', query: 'Times Sq' },
      }),
    ];
    cases[2]!.headers.set('Mcp-Method', 'prompts/list');
    cases[3]!.headers.set('Mcp-Name', 'wrong_tool');

    const responses = await Promise.all(cases.map(request => workerFetch(request)));
    for (const response of responses) {
      expect(response.status).toBe(400);
    }
    expect(record(await responses[0]!.json()).error).toMatchObject({ code: -32602 });
    for (const response of responses.slice(1)) {
      expect(record(await response.json()).error).toMatchObject({ code: -32020 });
    }
  });

  it('rejects modern metadata when the protocol version mirror header is missing', async () => {
    const request = await modernMcpRequest('server/discover');
    request.headers.delete('MCP-Protocol-Version');

    const response = await workerFetch(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32020 },
    });
  });

  it('keeps ordinary 2025 stateless requests headerless', async () => {
    const request = await legacyMcpRequest('tools/list');
    expect(request.headers.has('MCP-Protocol-Version')).toBe(false);

    const response = await workerFetch(request);

    expect(response.status).toBe(200);
    const result = onlyResult(await readMcpResponse(response));
    expect((result.tools as Array<{ name: string }>).map(tool => tool.name))
      .toEqual(EXPECTED_TOOL_NAMES);
  });

  it('enforces Host and browser Origin while allowing Origin-less desktop requests', async () => {
    const allowed = await workerFetch(await modernMcpRequest('server/discover', {}, {
      headers: { Origin: TEST_ORIGIN },
    }));
    const desktop = await workerFetch(await modernMcpRequest('server/discover'));
    const badOrigin = await workerFetch(await modernMcpRequest('server/discover', {}, {
      headers: { Origin: 'https://attacker.example' },
    }));
    const malformedOrigin = await workerFetch(await modernMcpRequest('server/discover', {}, {
      headers: { Origin: 'not a url' },
    }));
    const badHostRequest = await modernMcpRequest('server/discover');
    badHostRequest.headers.set('Host', 'attacker.example');
    const badHost = await workerFetch(badHostRequest);
    const insecureRequest = await modernMcpRequest('server/discover');
    const insecureUrl = new URL(insecureRequest.url);
    insecureUrl.protocol = 'http:';
    const insecureOrigin = await workerFetch(new Request(insecureUrl, insecureRequest));

    expect(allowed.status).toBe(200);
    expect(desktop.status).toBe(200);
    expect(badOrigin.status).toBe(403);
    expect(malformedOrigin.status).toBe(403);
    expect(badHost.status).toBe(403);
    expect(insecureOrigin.status).toBe(403);
  });

  it('serves canonical preflight without consuming an authentication boundary', async () => {
    const response = await workerFetch(`${TEST_ORIGIN}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Host: 'metro-mcp.anuragd.me',
        Origin: TEST_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'MCP-Protocol-Version, Mcp-Method, Mcp-Name',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-methods'))
      .toBe('GET, POST, DELETE, OPTIONS');
    expect(response.headers.has('www-authenticate')).toBe(false);
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
    const response = await workerFetch(`${TEST_ORIGIN}${pathname}`, {
      method,
      headers: { Host: 'metro-mcp.anuragd.me' },
    });

    expect(response.status).toBe(404);
  });

  it('accepts a stale Authorization header as anonymous input', async () => {
    const request = await modernMcpRequest('server/discover', {}, {
      token: 'canary-do-not-log',
    });

    const response = await workerFetch(request);

    expect(response.status).toBe(200);
    expect(response.headers.has('www-authenticate')).toBe(false);
  });

  it('streams request-scoped progress before the final result', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://api.wmata.com/Rail.svc/json/jStations') {
        return Response.json({ Stations: [] });
      }
      throw new Error(`Unmatched outbound request: ${request.url}`);
    });

    const response = await workerFetch(await modernMcpRequest('tools/call', {
      name: 'get_all_stations',
      arguments: { city: 'dc' },
    }, {
      meta: { progressToken: 'progress-1' },
      headers: { Accept: 'text/event-stream' },
    }));
    const messages = await readMcpResponse(response);

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(messages.map(message => record(message).method ?? 'result')).toEqual([
      'notifications/progress',
      'notifications/progress',
      'result',
    ]);
    expect(record(record(messages[0]).params)).toMatchObject({ progress: 0, total: 2 });
    expect(record(record(messages[1]).params)).toMatchObject({ progress: 1, total: 2 });
  });

  it('aborts mocked upstream when the response stream is cancelled', async () => {
    let upstreamAborted = false;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== 'https://api.wmata.com/Rail.svc/json/jStations') {
        throw new Error(`Unmatched outbound request: ${request.url}`);
      }
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          upstreamAborted = true;
          reject(request.signal.reason);
        }, { once: true });
      });
    });

    const response = await worker.fetch(await modernMcpRequest('tools/call', {
      name: 'get_all_stations',
      arguments: { city: 'dc' },
    }, {
      meta: { progressToken: 'cancel-progress' },
      headers: { Accept: 'text/event-stream' },
    }), env, createExecutionContext());
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('notifications/progress');
    await reader.cancel('client stopped reading');
    await vi.waitFor(() => expect(upstreamAborted).toBe(true));
  });

  it('enforces and recovers a Workerd limiter quota at the public MCP boundary', async () => {
    const rateLimitKey = '198.51.100.250';
    const request = async () => {
      const next = await modernMcpRequest('server/discover');
      next.headers.set('CF-Connecting-IP', rateLimitKey);
      return workerFetch(next);
    };

    const deniedEpoch = await enterFreshRateLimitEpoch();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await request()).status).toBe(200);
    }
    const denied = await request();
    expect(denied.status).toBe(429);
    expect(Math.floor(Date.now() / RATE_LIMIT_PERIOD_MS)).toBe(deniedEpoch);
    expect(await denied.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Rate limit exceeded' },
      id: null,
    });

    const recoveryDelay = (deniedEpoch + 1) * RATE_LIMIT_PERIOD_MS - Date.now() + 25;
    await sleep(Math.max(0, recoveryDelay));
    expect(Math.floor(Date.now() / RATE_LIMIT_PERIOD_MS)).toBeGreaterThan(deniedEpoch);
    expect((await request()).status).toBe(200);
  }, 35_000);
});
