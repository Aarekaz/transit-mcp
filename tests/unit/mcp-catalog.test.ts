import {
  createMcpHandler,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetroMcpContext } from '../../src/mcp/context';
import { createMetroMcpServer } from '../../src/mcp/server';
import {
  EXPECTED_INTENTIONAL_DEVIATIONS,
  EXPECTED_NESTED_OUTPUT_SCHEMAS,
  EXPECTED_OUTPUT_SCHEMA_SIGNATURES,
  EXPECTED_PROMPT_NAMES,
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

function outputSchemaSignatures(schema: JsonSchema): Record<string, string> {
  const signatures: Record<string, string> = {};

  const visit = (candidate: JsonSchema, path: string): void => {
    const current = nonNullSchema(candidate);
    if (current.type === 'array' && current.items) {
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

function requestContext(signal: AbortSignal): ServerContext {
  return {
    mcpReq: {
      id: 1,
      method: 'tools/call',
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

afterEach(() => {
  vi.clearAllMocks();
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
      expect(outputSchemaSignatures(tool.outputSchema ?? {})).toEqual(
        EXPECTED_OUTPUT_SCHEMA_SIGNATURES[tool.name as ToolName],
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
});
