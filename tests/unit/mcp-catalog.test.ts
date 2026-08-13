import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  createMcpHandler,
  type McpRequestContext,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { MetroMcpContext } from '../../src/mcp/context';
import { createMetroMcpServer } from '../../src/mcp/server';
import {
  EXPECTED_INTENTIONAL_DEVIATIONS,
  EXPECTED_INPUT_SCHEMA_SIGNATURES,
  EXPECTED_NESTED_OUTPUT_SCHEMAS,
  EXPECTED_OUTPUT_SCHEMA_SIGNATURES,
  EXPECTED_PROMPT_CONTRACTS,
  EXPECTED_PROMPT_NAMES,
  EXPECTED_RESOURCE_CONTRACTS,
  EXPECTED_RESOURCE_NAMES,
  EXPECTED_TOOL_CONTRACTS,
  EXPECTED_TOOL_NAMES,
} from '../fixtures/mcp-contracts';
import { createMockEnv } from '../setup';

const { getTransitClientMock } = vi.hoisted(() => ({
  getTransitClientMock: vi.fn(),
}));

vi.mock('../../src/transit/registry', () => ({
  getTransitClient: getTransitClientMock,
}));

type ToolName = (typeof EXPECTED_TOOL_NAMES)[number];

type RegisteredTool = {
  title?: string;
  description?: string;
  annotations?: unknown;
  inputSchema: unknown;
  outputSchema: {
    safeParse: (value: unknown) => { success: boolean };
  };
  handler: (
    args: Record<string, unknown>,
    context: ServerContext,
  ) => Promise<unknown> | unknown;
};

type RegisteredResourceTemplate = {
  title?: string;
  metadata?: {
    description?: string;
    mimeType?: string;
  };
  cacheHint?: {
    ttlMs?: number;
    cacheScope?: string;
  };
  resourceTemplate: {
    uriTemplate: { toString: () => string };
    listCallback?: (context: ServerContext) => Promise<unknown> | unknown;
  };
  readCallback: (
    uri: URL,
    variables: Record<string, string | string[]>,
    context: ServerContext,
  ) => Promise<unknown> | unknown;
};

type RegisteredPrompt = {
  title?: string;
  description?: string;
  argsSchema?: {
    safeParse: (value: unknown) => { success: boolean };
  };
  handler: (
    args: Record<string, unknown> | undefined,
    context: ServerContext,
  ) => Promise<unknown> | unknown;
};

type ToolWireContract = {
  name: string;
  title?: string;
  description?: string;
  annotations?: unknown;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
};

type JsonSchema = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, unknown>;
  required?: string[];
};

function schemaSignature(schema: JsonSchema): string {
  if ('const' in schema) return `const:${JSON.stringify(schema.const)}`;
  if (schema.enum) return `enum:${schema.enum.join('|')}`;
  if (schema.anyOf) {
    return schema.anyOf.map(schemaSignature).sort().join('|');
  }
  return schema.type ?? 'unknown';
}

function schemaSignatures(schema: JsonSchema): Record<string, string> {
  const signatures: Record<string, string> = {};

  const visit = (candidate: JsonSchema, path: string): void => {
    const current = nonNullSchema(candidate);
    if (current.type === 'array' && current.items) {
      signatures[`${path}[]`] = schemaSignature(current.items);
      visit(current.items, `${path}[]`);
      return;
    }
    for (const [name, property] of Object.entries(current.properties ?? {})) {
      const propertyPath = path ? `${path}.${name}` : name;
      signatures[propertyPath] = schemaSignature(property as JsonSchema);
      visit(property as JsonSchema, propertyPath);
    }
  };

  visit(schema, '');
  return signatures;
}

function nonNullSchema(schema: JsonSchema): JsonSchema {
  return schema.anyOf?.find(candidate => candidate.type !== 'null') ?? schema;
}

function nestedSchemaContract(schema: JsonSchema): {
  keys: string[];
  required: string[];
} {
  const keys: string[] = [];
  const required: string[] = [];

  const visit = (candidate: JsonSchema, path: string): void => {
    const current = nonNullSchema(candidate);
    if (current.type === 'array' && current.items) {
      visit(current.items, `${path}[]`);
      return;
    }

    const properties = current.properties;
    if (!properties) return;
    const requiredNames = new Set(current.required ?? []);
    for (const [name, property] of Object.entries(properties)) {
      const propertyPath = path ? `${path}.${name}` : name;
      if (path) keys.push(propertyPath);
      if (path && requiredNames.has(name)) required.push(propertyPath);
      visit(property as JsonSchema, propertyPath);
    }
  };

  visit(schema, '');
  return { keys, required };
}

function testContext(): MetroMcpContext {
  return {
    env: createMockEnv(),
    era: 'modern',
    props: {
      userId: '42',
      userLogin: 'anurag',
      clientId: 'catalog-test',
      scopes: ['transit:read'],
    },
  };
}

function registeredTools(server = createMetroMcpServer(testContext())): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
}

function requestContext(signal: AbortSignal, method = 'tools/call'): ServerContext {
  return {
    mcpReq: {
      id: 1,
      method,
      signal,
      requestState: () => undefined,
      send: vi.fn(),
      notify: vi.fn(),
      log: vi.fn(),
      elicitInput: vi.fn(),
      requestSampling: vi.fn(),
    },
  } as unknown as ServerContext;
}

function registeredResourceTemplates(
  server = createMetroMcpServer(testContext()),
): Record<string, RegisteredResourceTemplate> {
  return (server as unknown as {
    _registeredResourceTemplates: Record<string, RegisteredResourceTemplate>;
  })._registeredResourceTemplates;
}

function registeredPrompts(
  server = createMetroMcpServer(testContext()),
): Record<string, RegisteredPrompt> {
  return (server as unknown as {
    _registeredPrompts: Record<string, RegisteredPrompt>;
  })._registeredPrompts;
}

async function invoke(
  tools: Record<string, RegisteredTool>,
  name: ToolName,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const registration = tools[name];
  if (!registration) throw new Error(`Missing registered tool: ${name}`);
  return await registration.handler(args, requestContext(signal));
}

function expectComplete(result: unknown, structuredContent: Record<string, unknown>): void {
  expect(result).toEqual({
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
}

async function listToolsOverSdkWire(): Promise<ToolWireContract[]> {
  const context = testContext();
  const handler = createMcpHandler(sdkContext => createMetroMcpServer({
    ...context,
    era: sdkContext.era,
    authInfo: sdkContext.authInfo,
  }));

  try {
    const response = await handler.fetch(new Request('https://metro.test/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    }));
    expect(response.status).toBe(200);

    const body = await response.text();
    const data = body
      .split('\n')
      .find(line => line.startsWith('data: '))
      ?.slice('data: '.length);
    if (!data) throw new Error(`Missing tools/list result in wire response: ${body}`);

    const message = JSON.parse(data) as {
      result?: { tools?: ToolWireContract[] };
    };
    if (!message.result?.tools) throw new Error(`Missing tools in wire response: ${data}`);
    return message.result.tools;
  } finally {
    await handler.close();
  }
}

async function requestOverSdkWire(
  factory: (context: McpRequestContext) => McpServer,
  method: string,
  params: Record<string, unknown>,
  options: { modern?: boolean; signal?: AbortSignal } = {},
): Promise<{ result?: Record<string, unknown>; error?: Record<string, unknown> }> {
  const handler = createMcpHandler(factory);
  try {
    const wireParams = options.modern
      ? {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        }
      : params;
    const response = await handler.fetch(new Request('https://metro.test/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(options.modern
          ? {
              'mcp-method': method,
              ...(
                typeof (params.name ?? params.uri) === 'string'
                  ? { 'mcp-name': String(params.name ?? params.uri) }
                  : {}
              ),
              'mcp-protocol-version': '2026-07-28',
            }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: wireParams }),
      signal: options.signal,
    }));
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split('\n').find(line => line.startsWith('data: '))?.slice('data: '.length)
      : body;
    if (!payload) throw new Error(`Missing ${method} result in wire response: ${body}`);
    return JSON.parse(payload) as {
      result?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
  } finally {
    await handler.close();
  }
}

function metroServerFactory(context = testContext()) {
  return (sdkContext: McpRequestContext) => createMetroMcpServer({
    ...context,
    era: sdkContext.era,
    authInfo: sdkContext.authInfo,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('golden MCP catalog', () => {
  it('enumerates only the two approved behavior deviations and future catalog names', () => {
    expect(EXPECTED_INTENTIONAL_DEVIATIONS).toEqual([
      'Modern ambiguous get_station_predictions returns MRTR station selection.',
      'Legacy ambiguous get_station_predictions returns candidate retry guidance.',
    ]);
    expect(EXPECTED_RESOURCE_NAMES).toEqual(['station', 'route', 'incidents']);
    expect(EXPECTED_PROMPT_NAMES).toEqual([
      'service-briefing',
      'commute-planner',
      'accessibility-check',
    ]);
  });

  it('exposes all thirteen tools in exact order through the SDK tools/list wire', async () => {
    const tools = await listToolsOverSdkWire();

    expect(tools.map(tool => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('preserves golden metadata and top-level schema requiredness on the SDK wire', async () => {
    const tools = await listToolsOverSdkWire();

    for (const tool of tools) {
      const expected = EXPECTED_TOOL_CONTRACTS[tool.name as ToolName];
      expect(expected, `unexpected tool ${tool.name}`).toBeDefined();
      expect({
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        input: {
          keys: Object.keys(tool.inputSchema.properties ?? {}),
          required: tool.inputSchema.required ?? [],
        },
        output: {
          keys: Object.keys(tool.outputSchema?.properties ?? {}),
          required: tool.outputSchema?.required ?? [],
        },
      }).toEqual({
        title: expected.title,
        description: expected.description,
        annotations: expected.annotations,
        input: expected.input,
        output: expected.output,
      });
    }
  });

  it('preserves every nested output key and required field on the SDK wire', async () => {
    const tools = await listToolsOverSdkWire();

    for (const tool of tools) {
      expect(nestedSchemaContract(tool.outputSchema ?? {})).toEqual(
        EXPECTED_NESTED_OUTPUT_SCHEMAS[tool.name as ToolName],
      );
    }
  });

  it('preserves output scalar, collection, nullable, enum, and literal signatures', async () => {
    const tools = await listToolsOverSdkWire();

    for (const tool of tools) {
      expect(schemaSignatures(tool.outputSchema ?? {})).toEqual(
        EXPECTED_OUTPUT_SCHEMA_SIGNATURES[tool.name as ToolName],
      );
    }
  });

  it('preserves every input type, nullable union, enum, and literal signature', async () => {
    const tools = await listToolsOverSdkWire();

    for (const tool of tools) {
      expect(schemaSignatures(tool.inputSchema)).toEqual(
        EXPECTED_INPUT_SCHEMA_SIGNATURES[tool.name as ToolName],
      );
    }
  });

  it('detects representative schema mutations instead of normalizing them away', async () => {
    const tools = await listToolsOverSdkWire();
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool])) as Record<
      ToolName,
      ToolWireContract
    >;

    const cityEnum = structuredClone(byName.get_incidents.inputSchema);
    cityEnum.properties!.city = { type: 'string' };
    expect(schemaSignatures(cityEnum)).not.toEqual(
      EXPECTED_INPUT_SCHEMA_SIGNATURES.get_incidents,
    );

    const optionalNullable = structuredClone(byName.get_bus_positions.outputSchema!);
    optionalNullable.properties!.routeFilter = { type: 'string' };
    expect(schemaSignatures(optionalNullable)).not.toEqual(
      EXPECTED_OUTPUT_SCHEMA_SIGNATURES.get_bus_positions,
    );

    const numericInput = structuredClone(byName.get_bus_stops.inputSchema);
    numericInput.properties!.latitude = { type: 'string' };
    expect(schemaSignatures(numericInput)).not.toEqual(
      EXPECTED_INPUT_SCHEMA_SIGNATURES.get_bus_stops,
    );

    for (const [name, collection, field] of [
      ['get_incidents', 'incidents', 'linesAffected'],
      ['get_bus_stops', 'stops', 'routes'],
    ] as const) {
      const scalarArray = structuredClone(byName[name].outputSchema!);
      const rows = scalarArray.properties![collection] as JsonSchema;
      const row = rows.items!;
      (row.properties![field] as JsonSchema).items = { type: 'number' };
      expect(schemaSignatures(scalarArray)).not.toEqual(
        EXPECTED_OUTPUT_SCHEMA_SIGNATURES[name],
      );
    }
  });

  it('accepts every independently authored representative output in its registered schema', () => {
    const tools = registeredTools();

    for (const name of EXPECTED_TOOL_NAMES) {
      expect(
        tools[name]?.outputSchema.safeParse(
          EXPECTED_TOOL_CONTRACTS[name].structuredContent,
        ).success,
        `${name} representative output must satisfy its registered schema`,
      ).toBe(true);
    }
  });
});

describe('SDK v2 resource contracts', () => {
  it('registers exactly three templates in order with concrete metadata and cache hints', async () => {
    const resources = registeredResourceTemplates();

    expect(Object.entries(resources).map(([name, resource]) => [
      name,
      resource.resourceTemplate.uriTemplate.toString(),
    ])).toEqual([
      ['station', 'transit://stations/{city}/{id}'],
      ['route', 'transit://routes/{city}/{id}'],
      ['incidents', 'transit://incidents/{city}'],
    ]);
    for (const name of EXPECTED_RESOURCE_NAMES) {
      const expected = EXPECTED_RESOURCE_CONTRACTS[name];
      expect(resources[name]).toMatchObject({
        title: expected.title,
        metadata: {
          description: expected.description,
          mimeType: expected.mimeType,
        },
        cacheHint: expected.cacheHint,
      });
    }

    const message = await requestOverSdkWire(
      metroServerFactory(),
      'resources/templates/list',
      {},
      { modern: true },
    );
    expect(message.error).toBeUndefined();
    expect(message.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 86_400_000,
      cacheScope: 'public',
    });
    expect(message.result?.resourceTemplates).toEqual(
      EXPECTED_RESOURCE_NAMES.map(name => ({
        name,
        uriTemplate: EXPECTED_RESOURCE_CONTRACTS[name].uriTemplate,
        title: EXPECTED_RESOURCE_CONTRACTS[name].title,
        description: EXPECTED_RESOURCE_CONTRACTS[name].description,
        mimeType: EXPECTED_RESOURCE_CONTRACTS[name].mimeType,
      })),
    );
  });

  it('preserves station and route JSON reads, public cache, invalid-param misses, and signals', async () => {
    const station = EXPECTED_RESOURCE_CONTRACTS.station;
    const route = EXPECTED_RESOURCE_CONTRACTS.route;
    const getStations = vi.fn().mockResolvedValue([{
      id: '127',
      name: 'Times Square - 42 St',
      city: 'nyc',
      latitude: 40.755983,
      longitude: -73.987495,
      lines: ['1', '2', '3'],
      address: station.representativeContent.address,
      transfers: station.representativeContent.transfers,
    }]);
    const getRouteInfo = vi.fn(async (id: string) => (
      id === 'A' ? route.representativeContent : null
    ));
    getTransitClientMock.mockReturnValue({ getStations, getRouteInfo });
    const resources = registeredResourceTemplates();
    const signal = new AbortController().signal;
    const context = requestContext(signal, 'resources/read');

    await expect(resources.station!.readCallback(
      new URL(station.representativeUri),
      { city: 'nyc', id: '127' },
      context,
    )).resolves.toEqual({
      contents: [{
        uri: station.representativeUri,
        mimeType: station.mimeType,
        text: JSON.stringify(station.representativeContent),
      }],
    });
    await expect(resources.route!.readCallback(
      new URL(route.representativeUri),
      { city: 'nyc', id: 'A' },
      context,
    )).resolves.toEqual({
      contents: [{
        uri: route.representativeUri,
        mimeType: route.mimeType,
        text: JSON.stringify(route.representativeContent),
      }],
    });
    expect(getStations).toHaveBeenCalledWith(signal);
    expect(getRouteInfo).toHaveBeenCalledWith('A', signal);

    for (const [name, uri, variables, message] of [
      ['station', 'transit://stations/nyc/missing', { city: 'nyc', id: 'missing' }, 'Station not found: missing (city: nyc)'],
      ['route', 'transit://routes/nyc/missing', { city: 'nyc', id: 'missing' }, 'Route not found: missing (city: nyc)'],
    ] as const) {
      const failure = resources[name]!.readCallback(new URL(uri), variables, context);
      await expect(failure).rejects.toBeInstanceOf(ProtocolError);
      await expect(failure).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message,
      });
    }

    for (const [uri, expected] of [
      [station.representativeUri, station],
      [route.representativeUri, route],
    ] as const) {
      const message = await requestOverSdkWire(
        metroServerFactory(),
        'resources/read',
        { uri },
        { modern: true },
      );
      expect(message.error).toBeUndefined();
      expect(message.result).toMatchObject({
        resultType: 'complete',
        ttlMs: 86_400_000,
        cacheScope: 'public',
      });
      expect(message.result?.contents).toEqual([{
        uri,
        mimeType: expected.mimeType,
        text: JSON.stringify(expected.representativeContent),
      }]);
    }

    for (const uri of ['transit://stations/nyc/missing', 'transit://routes/nyc/missing']) {
      const message = await requestOverSdkWire(
        metroServerFactory(),
        'resources/read',
        { uri },
        { modern: true },
      );
      expect(message.error).toMatchObject({ code: -32602 });
    }

    const controller = new AbortController();
    const reason = Object.assign(new Error('resource request closed'), {
      name: 'RequestClosed',
    });
    controller.abort(reason);
    getStations.mockRejectedValue(reason);
    getRouteInfo.mockRejectedValue(reason);
    const abortedResources = registeredResourceTemplates();
    const abortedContext = requestContext(controller.signal, 'resources/read');
    await expect(abortedResources.station!.readCallback(
      new URL(station.representativeUri),
      { city: 'nyc', id: '127' },
      abortedContext,
    )).rejects.toBe(reason);
    await expect(abortedResources.route!.readCallback(
      new URL(route.representativeUri),
      { city: 'nyc', id: 'A' },
      abortedContext,
    )).rejects.toBe(reason);
  });

  it('lists only both incident feeds and preserves the live private read body and signal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T18:00:00.000Z'));
    const incidents = EXPECTED_RESOURCE_CONTRACTS.incidents;
    const getIncidents = vi.fn().mockResolvedValue([{
      city: 'dc',
      incidentId: 'INC-42',
      description: 'Red Line delay',
      linesAffected: ['RD'],
      severity: 'Major',
      incidentType: 'Delay',
      timestamp: '2026-08-13T17:55:00.000Z',
    }]);
    getTransitClientMock.mockReturnValue({ getIncidents });

    const listMessage = await requestOverSdkWire(
      metroServerFactory(),
      'resources/list',
      {},
      { modern: true },
    );
    expect(listMessage.error).toBeUndefined();
    expect(listMessage.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 86_400_000,
      cacheScope: 'public',
    });
    expect(listMessage.result?.resources).toEqual(incidents.listedResources);

    const resource = registeredResourceTemplates().incidents!;
    const signal = new AbortController().signal;
    await expect(resource.readCallback(
      new URL(incidents.representativeUri),
      { city: 'dc' },
      requestContext(signal, 'resources/read'),
    )).resolves.toEqual({
      contents: [{
        uri: incidents.representativeUri,
        mimeType: incidents.mimeType,
        text: JSON.stringify(incidents.representativeContent),
      }],
    });
    expect(getIncidents).toHaveBeenCalledWith(signal);

    const readMessage = await requestOverSdkWire(
      metroServerFactory(),
      'resources/read',
      { uri: incidents.representativeUri },
      { modern: true },
    );
    expect(readMessage.error).toBeUndefined();
    expect(readMessage.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
    });
    expect(readMessage.result?.contents).toEqual([{
      uri: incidents.representativeUri,
      mimeType: incidents.mimeType,
      text: JSON.stringify(incidents.representativeContent),
    }]);

    const controller = new AbortController();
    const reason = Object.assign(new Error('incident resource request closed'), {
      name: 'RequestClosed',
    });
    controller.abort(reason);
    getIncidents.mockRejectedValue(reason);
    await expect(registeredResourceTemplates().incidents!.readCallback(
      new URL(incidents.representativeUri),
      { city: 'dc' },
      requestContext(controller.signal, 'resources/read'),
    )).rejects.toBe(reason);
  });
});

describe('SDK v2 prompt contracts', () => {
  it('lists exactly three prompts in order with concrete metadata and argument schemas', async () => {
    const prompts = registeredPrompts();
    expect(Object.keys(prompts)).toEqual(EXPECTED_PROMPT_NAMES);
    expect(prompts['service-briefing']!.argsSchema!.safeParse({ city: 'dc' }).success).toBe(true);
    expect(prompts['service-briefing']!.argsSchema!.safeParse({ city: 'bos' }).success).toBe(false);
    expect(prompts['commute-planner']!.argsSchema!.safeParse({
      city: 'nyc',
      fromStation: 'Times Square',
      toStation: 'Jay St',
    }).success).toBe(true);
    expect(prompts['commute-planner']!.argsSchema!.safeParse({
      city: 'nyc',
      fromStation: 'Times Square',
    }).success).toBe(false);
    expect(prompts['accessibility-check']!.argsSchema!.safeParse({
      stationNames: 'Metro Center',
    }).success).toBe(true);
    expect(prompts['accessibility-check']!.argsSchema!.safeParse({
      stationNames: 42,
    }).success).toBe(false);

    const message = await requestOverSdkWire(
      metroServerFactory(),
      'prompts/list',
      {},
      { modern: true },
    );
    expect(message.error).toBeUndefined();
    expect(message.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 86_400_000,
      cacheScope: 'public',
    });
    expect(message.result?.prompts).toEqual(
      EXPECTED_PROMPT_NAMES.map(name => ({
        name,
        title: EXPECTED_PROMPT_CONTRACTS[name].title,
        description: EXPECTED_PROMPT_CONTRACTS[name].description,
        arguments: EXPECTED_PROMPT_CONTRACTS[name].arguments,
      })),
    );
  });

  it('returns every preserved prompt variant as one exact user text message', async () => {
    for (const name of EXPECTED_PROMPT_NAMES) {
      for (const example of EXPECTED_PROMPT_CONTRACTS[name].examples) {
        const message = await requestOverSdkWire(
          metroServerFactory(),
          'prompts/get',
          { name, arguments: example.arguments },
          { modern: true },
        );
        expect(message.error, `${name} should succeed`).toBeUndefined();
        expect(message.result).toMatchObject({
          resultType: 'complete',
        });
        expect(message.result?.messages).toEqual([{
          role: 'user',
          content: { type: 'text', text: example.text },
        }]);
      }
    }
  });

  it('references only registered get/search tools and rejects missing required arguments', async () => {
    const referencedTools = new Set<string>();

    for (const name of EXPECTED_PROMPT_NAMES) {
      for (const example of EXPECTED_PROMPT_CONTRACTS[name].examples) {
        const message = await requestOverSdkWire(
          metroServerFactory(),
          'prompts/get',
          { name, arguments: example.arguments },
          { modern: true },
        );
        const messages = message.result?.messages as Array<{
          content?: { type?: string; text?: string };
        }> | undefined;
        const text = messages?.[0]?.content?.text ?? '';
        for (const token of text.match(/\b(?:get|search)_[a-z_]+\b/g) ?? []) {
          referencedTools.add(token);
          expect(EXPECTED_TOOL_NAMES).toContain(token);
        }
      }
    }
    expect([...referencedTools].sort()).toEqual([
      'get_elevator_incidents',
      'get_incidents',
      'get_station_predictions',
      'get_stations_by_line',
      'search_stations',
    ]);

    const invalid = await requestOverSdkWire(
      metroServerFactory(),
      'prompts/get',
      { name: 'service-briefing', arguments: {} },
      { modern: true },
    );
    expect(invalid.error).toMatchObject({ code: -32602 });
  });
});

describe('SDK v2 tools/call wire behavior', () => {
  it('returns matching text and structured content from an assembled valid call', async () => {
    getTransitClientMock.mockReturnValue({
      getBusRoutes: vi.fn().mockResolvedValue([{
        RouteID: '30N',
        Name: 'Friendship Heights-Southeast',
        LineDescription: undefined,
      }]),
    });

    const message = await requestOverSdkWire(
      metroServerFactory(),
      'tools/call',
      { name: 'get_bus_routes', arguments: {} },
    );

    expect(message.error).toBeUndefined();
    expect(message.result).toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify(EXPECTED_TOOL_CONTRACTS.get_bus_routes.structuredContent),
      }],
      structuredContent: EXPECTED_TOOL_CONTRACTS.get_bus_routes.structuredContent,
    });
  });

  it('returns an SDK output validation error for malformed callback output', async () => {
    const message = await requestOverSdkWire(
      () => {
        const server = new McpServer({ name: 'malformed-output-test', version: '1.0.0' });
        server.registerTool(
          'malformed_output',
          {
            inputSchema: z.object({}),
            outputSchema: z.object({ value: z.string() }),
          },
          async () => ({
            content: [{ type: 'text' as const, text: '{"value":42}' }],
            structuredContent: { value: 42 as unknown as string },
          }),
        );
        return server;
      },
      'tools/call',
      { name: 'malformed_output', arguments: {} },
    );

    expect(message.error).toBeUndefined();
    expect(message.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Output validation error') }],
    });
  });
});

describe('remaining read-only tool outputs and cancellation', () => {
  it('maps incidentId to id and forwards the exact signal', async () => {
    const signal = new AbortController().signal;
    const getIncidents = vi.fn().mockResolvedValue([{
      city: 'dc',
      incidentId: 'INC-42',
      description: 'Red Line delay',
      linesAffected: ['RD'],
      severity: 'Major',
      incidentType: 'Delay',
      timestamp: '2026-08-13T18:00:00.000Z',
    }]);
    getTransitClientMock.mockReturnValue({ getIncidents });

    const result = await invoke(registeredTools(), 'get_incidents', { city: 'dc' }, signal);

    expect(getIncidents).toHaveBeenCalledWith(signal);
    expectComplete(result, EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent);
  });

  it('formats elevator incidents with the shared formatter and forwards the exact signal', async () => {
    const signal = new AbortController().signal;
    const getElevatorIncidents = vi.fn().mockResolvedValue([{
      UnitName: 'EL-1',
      UnitType: 'ELEVATOR',
      UnitStatus: null,
      StationCode: 'A01',
      StationName: 'Metro Center',
      LocationDescription: '12th St entrance',
      SymptomCode: null,
      SymptomDescription: 'Scheduled maintenance',
      TimeOutOfService: '6 hours',
      DisplayOrder: 1,
      DateOutOfServ: '2026-08-13T12:00:00.000Z',
      DateUpdated: '2026-08-13T18:00:00.000Z',
      EstimatedReturnToService: null,
    }]);
    getTransitClientMock.mockReturnValue({ getElevatorIncidents });

    const result = await invoke(
      registeredTools(),
      'get_elevator_incidents',
      { city: 'dc' },
      signal,
    );

    expect(getElevatorIncidents).toHaveBeenCalledWith(signal);
    expectComplete(result, EXPECTED_TOOL_CONTRACTS.get_elevator_incidents.structuredContent);
  });

  it('preserves bus prediction fields and nullable identifiers while forwarding the exact signal', async () => {
    const signal = new AbortController().signal;
    const getBusPredictions = vi.fn().mockResolvedValue([{
      DirectionNum: '1',
      DirectionText: 'NORTHBOUND',
      Minutes: 4,
      RouteID: '30N',
      VehicleID: undefined,
      TripID: undefined,
    }]);
    getTransitClientMock.mockReturnValue({ getBusPredictions });

    const result = await invoke(
      registeredTools(),
      'get_bus_predictions',
      { stopId: '1001195' },
      signal,
    );

    expect(getBusPredictions).toHaveBeenCalledWith('1001195', signal);
    expectComplete(result, EXPECTED_TOOL_CONTRACTS.get_bus_predictions.structuredContent);
  });

  it('maps bus routes and forwards the exact signal', async () => {
    const signal = new AbortController().signal;
    const getBusRoutes = vi.fn().mockResolvedValue([{
      RouteID: '30N',
      Name: 'Friendship Heights-Southeast',
      LineDescription: undefined,
    }]);
    getTransitClientMock.mockReturnValue({ getBusRoutes });

    const result = await invoke(registeredTools(), 'get_bus_routes', {}, signal);

    expect(getBusRoutes).toHaveBeenCalledWith(signal);
    expectComplete(result, EXPECTED_TOOL_CONTRACTS.get_bus_routes.structuredContent);
  });

  it('preserves bus stop coordinates/routes and nullable search location with the exact signal', async () => {
    const signal = new AbortController().signal;
    const getBusStops = vi.fn().mockResolvedValue([{
      StopID: '1001195',
      Name: '13TH ST NW + H ST NW',
      Lat: 38.9001,
      Lon: -77.0291,
      Routes: ['30N', '30S'],
    }]);
    getTransitClientMock.mockReturnValue({ getBusStops });

    const result = await invoke(registeredTools(), 'get_bus_stops', {}, signal);

    expect(getBusStops).toHaveBeenCalledWith(undefined, undefined, undefined, signal);
    expectComplete(result, EXPECTED_TOOL_CONTRACTS.get_bus_stops.structuredContent);
  });

  it('preserves all published bus-position fields and forwards the exact signal', async () => {
    const signal = new AbortController().signal;
    const getBusPositions = vi.fn().mockResolvedValue([{
      DateTime: '2026-08-13T18:01:00.000Z',
      Deviation: -2,
      DirectionNum: '1',
      DirectionText: 'NORTHBOUND',
      Lat: 38.91,
      Lon: -77.04,
      RouteID: '30N',
      TripEndTime: '2026-08-13T18:30:00.000Z',
      TripHeadsign: 'Friendship Heights',
      TripID: 'TRIP-1',
      TripStartTime: '2026-08-13T17:30:00.000Z',
      VehicleID: 'V100',
    }]);
    getTransitClientMock.mockReturnValue({ getBusPositions });

    const result = await invoke(
      registeredTools(),
      'get_bus_positions',
      { routeId: '30N' },
      signal,
    );

    expect(getBusPositions).toHaveBeenCalledWith('30N', signal);
    expectComplete(result, EXPECTED_TOOL_CONTRACTS.get_bus_positions.structuredContent);
  });

  it('labels train positions as DC and maps both direction values with the exact signal', async () => {
    const signal = new AbortController().signal;
    const getTrainPositions = vi.fn().mockResolvedValue([{
      TrainId: 'T1',
      TrainNumber: '101',
      CarCount: 8,
      DirectionNum: 1,
      CircuitId: 1234,
      DestinationStationCode: 'B11',
      LineCode: 'RD',
      SecondsAtLocation: 20,
      ServiceType: 'Normal',
    }, {
      TrainId: 'T2',
      TrainNumber: undefined,
      CarCount: undefined,
      DirectionNum: 2,
      CircuitId: undefined,
      DestinationStationCode: null,
      LineCode: null,
      SecondsAtLocation: undefined,
      ServiceType: undefined,
    }]);
    getTransitClientMock.mockReturnValue({ getTrainPositions });

    const result = await invoke(registeredTools(), 'get_train_positions', {}, signal);

    expect(getTrainPositions).toHaveBeenCalledWith(signal);
    expectComplete(result, EXPECTED_TOOL_CONTRACTS.get_train_positions.structuredContent);
  });

  it('keeps route info NYC-only, forwards each exact signal, and reports a readable miss', async () => {
    const successSignal = new AbortController().signal;
    const missingSignal = new AbortController().signal;
    const getRouteInfo = vi.fn()
      .mockResolvedValueOnce({
        routeId: 'A',
        shortName: 'A',
        longName: '8 Avenue Express',
        description: 'Express service in Manhattan and Brooklyn.',
        city: 'nyc',
      })
      .mockResolvedValueOnce(null);
    getTransitClientMock.mockReturnValue({ getRouteInfo });
    const tools = registeredTools();

    const result = await invoke(
      tools,
      'get_route_info',
      { city: 'nyc', routeId: 'A' },
      successSignal,
    );
    await expect(invoke(
      tools,
      'get_route_info',
      { city: 'nyc', routeId: 'missing' },
      missingSignal,
    )).rejects.toThrow("Route not found: missing. Make sure you're using the correct ID for nyc.");

    expect(getRouteInfo).toHaveBeenNthCalledWith(1, 'A', successSignal);
    expect(getRouteInfo).toHaveBeenNthCalledWith(2, 'missing', missingSignal);
    expectComplete(result, EXPECTED_TOOL_CONTRACTS.get_route_info.structuredContent);
  });

  it.each([
    ['get_incidents', 'getIncidents', { city: 'dc' }, (signal: AbortSignal) => [signal]],
    [
      'get_elevator_incidents',
      'getElevatorIncidents',
      { city: 'dc' },
      (signal: AbortSignal) => [signal],
    ],
    [
      'get_bus_predictions',
      'getBusPredictions',
      { stopId: '1001195' },
      (signal: AbortSignal) => ['1001195', signal],
    ],
    ['get_bus_routes', 'getBusRoutes', {}, (signal: AbortSignal) => [signal]],
    [
      'get_bus_stops',
      'getBusStops',
      {},
      (signal: AbortSignal) => [undefined, undefined, undefined, signal],
    ],
    [
      'get_bus_positions',
      'getBusPositions',
      {},
      (signal: AbortSignal) => [undefined, signal],
    ],
    ['get_train_positions', 'getTrainPositions', {}, (signal: AbortSignal) => [signal]],
    [
      'get_route_info',
      'getRouteInfo',
      { city: 'nyc', routeId: 'A' },
      (signal: AbortSignal) => ['A', signal],
    ],
  ] as const)(
    'preserves a custom cancellation reason by identity through %s',
    async (toolName, methodName, args, expectedArgs) => {
      const controller = new AbortController();
      const reason = Object.assign(new Error(`closed ${toolName}`), {
        name: 'RequestClosed',
      });
      controller.abort(reason);
      const transitMethod = vi.fn().mockRejectedValue(reason);
      getTransitClientMock.mockReturnValue({ [methodName]: transitMethod });

      await expect(invoke(
        registeredTools(),
        toolName,
        args,
        controller.signal,
      )).rejects.toBe(reason);
      expect(transitMethod).toHaveBeenCalledWith(...expectedArgs(controller.signal));
    },
  );

  it('forwards a partial bus geo search and preserves a null search location', async () => {
    const signal = new AbortController().signal;
    const getBusStops = vi.fn().mockResolvedValue([]);
    getTransitClientMock.mockReturnValue({ getBusStops });

    const result = await invoke(
      registeredTools(),
      'get_bus_stops',
      { latitude: 38.9 },
      signal,
    );

    expect(getBusStops).toHaveBeenCalledWith(38.9, undefined, undefined, signal);
    expectComplete(result, {
      city: 'dc',
      totalStops: 0,
      searchLocation: null,
      stops: [],
    });
  });

  it('preserves the published fallback for an unexpected train direction', async () => {
    const signal = new AbortController().signal;
    const getTrainPositions = vi.fn().mockResolvedValue([{
      TrainId: 'T99',
      TrainNumber: undefined,
      CarCount: undefined,
      DirectionNum: 99,
      CircuitId: undefined,
      DestinationStationCode: null,
      LineCode: null,
      SecondsAtLocation: undefined,
      ServiceType: undefined,
    }]);
    getTransitClientMock.mockReturnValue({ getTrainPositions });

    const result = await invoke(
      registeredTools(),
      'get_train_positions',
      {},
      signal,
    );

    expect(getTrainPositions).toHaveBeenCalledWith(signal);
    expectComplete(result, {
      city: 'dc',
      totalTrains: 1,
      trains: [{
        trainId: 'T99',
        trainNumber: null,
        line: null,
        destination: null,
        carCount: null,
        direction: 'Southbound/Westbound',
        circuitId: null,
        secondsAtLocation: null,
        serviceType: null,
      }],
    });
  });
});
