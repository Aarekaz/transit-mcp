import { createExecutionContext, SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../../src/index';

import {
  legacyMcpRequest,
  modernEnvelope,
  modernMcpRequest,
  readMcpResponse,
  testBearerToken,
  TEST_ORIGIN,
} from '../helpers/mcp-request';
import {
  EXPECTED_PROMPT_NAMES,
  EXPECTED_RESOURCE_NAMES,
  EXPECTED_TOOL_NAMES,
} from '../fixtures/mcp-contracts';

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
  it('returns the RFC 9728 challenge before MCP dispatch', async () => {
    const response = await SELF.fetch(`${TEST_ORIGIN}/mcp`, {
      method: 'POST',
      headers: { Host: 'metro-mcp.anuragd.me' },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('serves modern server/discover without initialize', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await SELF.fetch(await modernMcpRequest('server/discover'));
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
          tools: {},
          prompts: {},
          resources: {},
        },
      },
    });
  });

  it('exposes exactly 13 tools, 3 resource templates, and 3 prompts with modern cache hints', async () => {
    const [toolsResponse, resourcesResponse, promptsResponse] = await Promise.all([
      SELF.fetch(await modernMcpRequest('tools/list')),
      SELF.fetch(await modernMcpRequest('resources/templates/list')),
      SELF.fetch(await modernMcpRequest('prompts/list')),
    ]);

    const tools = onlyResult(await readMcpResponse(toolsResponse));
    const resources = onlyResult(await readMcpResponse(resourcesResponse));
    const prompts = onlyResult(await readMcpResponse(promptsResponse));

    expect((tools.tools as Array<{ name: string }>).map(tool => tool.name))
      .toEqual(EXPECTED_TOOL_NAMES);
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

  it('serves representative modern tool, resource, and prompt calls', async () => {
    const [toolResponse, resourceResponse, promptResponse] = await Promise.all([
      SELF.fetch(await modernMcpRequest('tools/call', {
        name: 'search_stations',
        arguments: { city: 'nyc', query: 'Times Sq' },
      })),
      SELF.fetch(await modernMcpRequest('resources/read', {
        uri: 'transit://stations/nyc/127',
      })),
      SELF.fetch(await modernMcpRequest('prompts/get', {
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
      SELF.fetch(await legacyMcpRequest('tools/list')),
      SELF.fetch(await legacyMcpRequest('tools/call', {
        name: 'search_stations',
        arguments: { city: 'nyc', query: 'Times Sq' },
      })),
      SELF.fetch(await legacyMcpRequest('tools/call', {
        name: 'get_station_predictions',
        arguments: { city: 'nyc', stationName: 'Broadway' },
      })),
    ]);

    const list = onlyResult(await readMcpResponse(listResponse));
    const call = onlyResult(await readMcpResponse(callResponse));
    const ambiguous = onlyResult(await readMcpResponse(ambiguousResponse));
    expect((list.tools as Array<{ name: string }>).map(tool => tool.name))
      .toEqual(EXPECTED_TOOL_NAMES);
    expect(call).toMatchObject({ structuredContent: { city: 'nyc', query: 'Times Sq' } });
    expect(ambiguous).toMatchObject({ isError: true });
    expect(JSON.stringify(ambiguous)).toContain('please call get_station_predictions again');
  });

  it('keeps /sse as an exact POST alias and rejects unsupported MCP methods before OAuth', async () => {
    const aliasResponse = await SELF.fetch(await modernMcpRequest(
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
      const response = await SELF.fetch(`${TEST_ORIGIN}${path}`, {
        method,
        headers: { Host: 'metro-mcp.anuragd.me' },
      });
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    }
  });

  it('ignores query-string credentials', async () => {
    for (const query of ['access_token=not-a-token', 'token=not-a-token']) {
      const response = await SELF.fetch(`${TEST_ORIGIN}/mcp?${query}`, {
        method: 'POST',
        headers: { Host: 'metro-mcp.anuragd.me' },
      });
      expect(response.status).toBe(401);
    }
  });

  it('returns SDK-defined errors for version, method, and name mismatches', async () => {
    const token = await testBearerToken();
    const cases = [
      new Request(`${TEST_ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
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
          Authorization: `Bearer ${token}`,
          Host: 'metro-mcp.anuragd.me',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'MCP-Protocol-Version': '2025-11-25',
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify(modernEnvelope('tools/list')),
      }),
      await modernMcpRequest('tools/list', {}, { token }),
      await modernMcpRequest('tools/call', {
        name: 'search_stations',
        arguments: { city: 'nyc', query: 'Times Sq' },
      }, { token }),
    ];
    cases[2]!.headers.set('Mcp-Method', 'prompts/list');
    cases[3]!.headers.set('Mcp-Name', 'wrong_tool');

    const responses = await Promise.all(cases.map(request => SELF.fetch(request)));
    for (const response of responses) {
      expect(response.status).toBe(400);
    }
    expect(record(await responses[0]!.json()).error).toMatchObject({ code: -32602 });
    for (const response of responses.slice(1)) {
      expect(record(await response.json()).error).toMatchObject({ code: -32020 });
    }
  });

  it('enforces Host and browser Origin while allowing Origin-less desktop requests', async () => {
    const token = await testBearerToken();
    const allowed = await SELF.fetch(await modernMcpRequest('server/discover', {}, {
      token,
      headers: { Origin: TEST_ORIGIN },
    }));
    const desktop = await SELF.fetch(await modernMcpRequest('server/discover', {}, { token }));
    const badOrigin = await SELF.fetch(await modernMcpRequest('server/discover', {}, {
      token,
      headers: { Origin: 'https://attacker.example' },
    }));
    const malformedOrigin = await SELF.fetch(await modernMcpRequest('server/discover', {}, {
      token,
      headers: { Origin: 'not a url' },
    }));
    const badHostRequest = await modernMcpRequest('server/discover', {}, { token });
    badHostRequest.headers.set('Host', 'attacker.example');
    const badHost = await SELF.fetch(badHostRequest);

    expect(allowed.status).toBe(200);
    expect(desktop.status).toBe(200);
    expect(badOrigin.status).toBe(403);
    expect(malformedOrigin.status).toBe(403);
    expect(badHost.status).toBe(403);
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

    const response = await SELF.fetch(await modernMcpRequest('tools/call', {
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
});
