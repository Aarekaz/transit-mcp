import {
  ProtocolErrorCode,
  createRequestStateCodec,
  type McpServer,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MetroMcpContext,
  MetroRequestState,
} from '../../src/mcp/context';
import { registerStationTools } from '../../src/mcp/tools/stations';
import { TransitError } from '../../src/error-handler';
import type {
  TransitAPIClient,
  TransitPrediction,
  TransitStation,
} from '../../src/transit/base';
import { createMockEnv } from '../setup';

const { getTransitClientMock } = vi.hoisted(() => ({
  getTransitClientMock: vi.fn(),
}));

vi.mock('../../src/transit/registry', () => ({
  getTransitClient: getTransitClientMock,
}));

const REQUEST_STATE_KEY = 'station-test-request-state-key-32-bytes-minimum';

type StationToolConfig = {
  title?: string;
  description?: string;
  annotations?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

type StationToolCallback = (
  args: Record<string, unknown>,
  context: ServerContext,
) => Promise<unknown> | unknown;

type CapturedTool = {
  config: StationToolConfig;
  callback: StationToolCallback;
};

const nyc127: TransitStation = {
  id: '127',
  name: 'Times Square - 42 St',
  city: 'nyc',
  latitude: 40.755983,
  longitude: -73.987495,
  lines: ['1', '2', '3'],
  address: {
    street: 'Broadway & 42nd St',
    city: 'New York',
    state: 'NY',
    zip: '10036',
  },
  transfers: [{
    toStationId: 'R16',
    toStationName: 'Times Square - 42 St',
    transferTime: 75,
    transferType: 'platform',
  }],
};

const nycR16: TransitStation = {
  id: 'R16',
  name: 'Times Square - Broadway',
  city: 'nyc',
  latitude: 40.754672,
  longitude: -73.986754,
  lines: ['N', 'Q', 'R', 'W'],
};

const dcA01: TransitStation = {
  id: 'A01',
  name: 'Metro Center',
  city: 'dc',
  latitude: 38.898303,
  longitude: -77.028099,
  lines: ['RD', 'BL', 'OR', 'SV'],
  address: {
    street: '607 13th St NW',
    city: 'Washington',
    state: 'DC',
    zip: '20005',
  },
};

const dcPrediction: TransitPrediction = {
  city: 'dc',
  line: 'RD',
  destination: 'Glenmont',
  arrivalTime: '2026-08-13T18:05:00.000Z',
  minutesAway: 5,
  cars: '8',
  direction: 'NORTH',
  track: '2',
};

function metroContext(
  era: MetroMcpContext['era'] = 'modern',
  userId = 'user-42',
): MetroMcpContext {
  return {
    env: createMockEnv({ MCP_REQUEST_STATE_KEY: REQUEST_STATE_KEY }),
    era,
    props: {
      userId,
      userLogin: 'anurag',
      clientId: 'test-client',
      scopes: ['transit:read'],
    },
  };
}

function stateCodecFor(context: MetroMcpContext): RequestStateCodec<MetroRequestState> {
  return createRequestStateCodec<MetroRequestState>({
    key: context.env.MCP_REQUEST_STATE_KEY,
    ttlSeconds: 300,
    bind: handlerContext => [
      context.props.userId,
      handlerContext.mcpReq.method,
    ].join('\u0000'),
  });
}

function captureStationTools(
  context = metroContext(),
  stateCodec = stateCodecFor(context),
) {
  const registrations = new Map<string, CapturedTool>();
  const registerTool = vi.fn((
    name: string,
    config: StationToolConfig,
    callback: StationToolCallback,
  ) => {
    registrations.set(name, { config, callback });
    return {};
  });
  const server = { registerTool } as unknown as McpServer;

  registerStationTools(server, context, stateCodec);

  return { context, stateCodec, registrations, registerTool };
}

function requestContext(options: {
  signal?: AbortSignal;
  progressToken?: string | number;
  state?: MetroRequestState;
  inputResponses?: Record<string, unknown>;
  method?: string;
  notify?: ReturnType<typeof vi.fn>;
} = {}): ServerContext {
  const signal = options.signal ?? new AbortController().signal;
  return {
    mcpReq: {
      id: 1,
      method: options.method ?? 'tools/call',
      ...(options.progressToken === undefined
        ? {}
        : { _meta: { progressToken: options.progressToken } }),
      inputResponses: options.inputResponses,
      requestState: () => options.state,
      signal,
      send: vi.fn(),
      notify: options.notify ?? vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
      elicitInput: vi.fn(),
      requestSampling: vi.fn(),
    },
  } as unknown as ServerContext;
}

function tool(
  registrations: Map<string, CapturedTool>,
  name: string,
): CapturedTool {
  const registration = registrations.get(name);
  if (!registration) throw new Error(`Missing captured tool ${name}`);
  return registration;
}

function clientWith(
  overrides: Partial<Record<keyof TransitAPIClient, unknown>> = {},
): TransitAPIClient {
  return {
    searchStation: vi.fn().mockResolvedValue([]),
    getStationPredictions: vi.fn().mockResolvedValue([]),
    getStationsByLine: vi.fn().mockResolvedValue([]),
    getStations: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as TransitAPIClient;
}

async function invoke(
  registration: CapturedTool,
  args: Record<string, unknown>,
  context = requestContext(),
) {
  return await registration.callback(args, context);
}

async function mintSelectionState(
  stateCodec: RequestStateCodec<MetroRequestState>,
  context = requestContext(),
  overrides: Partial<MetroRequestState> = {},
) {
  return await stateCodec.mint({
    phase: 'station-selection',
    tool: 'get_station_predictions',
    city: 'nyc',
    query: 'times square',
    candidateIds: ['127', 'R16'],
    ...overrides,
  }, context);
}

async function invokeRetry(options: {
  registration: CapturedTool;
  codec: RequestStateCodec<MetroRequestState>;
  wireState: string;
  args?: Record<string, unknown>;
  inputResponses?: Record<string, unknown>;
  method?: string;
}) {
  const verifierContext = requestContext({ method: options.method });
  const verified = await options.codec.verify(options.wireState, verifierContext);
  return await invoke(
    options.registration,
    options.args ?? { city: 'nyc', stationName: 'Times Square' },
    requestContext({
      method: options.method,
      state: verified,
      inputResponses: options.inputResponses,
    }),
  );
}

function decodeStateEnvelope(state: string): unknown {
  const encoded = state.split('.')[1];
  if (!encoded) throw new Error('Missing state payload');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('station tool contracts', () => {
  it('registers exactly five read-only station tools in wire-visible order', () => {
    const { registrations, registerTool } = captureStationTools();

    expect([...registrations.keys()]).toEqual([
      'get_station_predictions',
      'search_stations',
      'get_stations_by_line',
      'get_all_stations',
      'get_station_transfers',
    ]);
    expect(registerTool).toHaveBeenCalledTimes(5);
    for (const registration of registrations.values()) {
      expect(registration.config.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it.each([
    ['dc', 'a01', 'A01'],
    ['nyc', '127', '127'],
  ] as const)('uses direct %s station code %s without searching', async (city, input, stationId) => {
    const signal = new AbortController().signal;
    const client = clientWith({
      getStationPredictions: vi.fn().mockResolvedValue(city === 'dc' ? [dcPrediction] : []),
    });
    getTransitClientMock.mockReturnValue(client);
    const { registrations } = captureStationTools();

    const result = await invoke(
      tool(registrations, 'get_station_predictions'),
      { city, stationName: input },
      requestContext({ signal }),
    );

    expect(client.searchStation).not.toHaveBeenCalled();
    expect(client.getStationPredictions).toHaveBeenCalledWith(stationId, signal);
    expect(result).toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({
          city,
          station: stationId,
          predictions: city === 'dc' ? [{
            line: 'RD',
            destination: 'Glenmont',
            minutesAway: 5,
            arrivalTime: '2026-08-13T18:05:00.000Z',
            arrivalStatus: 'SCHEDULED',
            cars: '8',
            direction: 'NORTH',
            track: '2',
          }] : [],
        }),
      }],
      structuredContent: {
        city,
        station: stationId,
        predictions: city === 'dc' ? [{
          line: 'RD',
          destination: 'Glenmont',
          minutesAway: 5,
          arrivalTime: '2026-08-13T18:05:00.000Z',
          arrivalStatus: 'SCHEDULED',
          cars: '8',
          direction: 'NORTH',
          track: '2',
        }] : [],
      },
    });
  });

  it('resolves one station-name match and forwards the signal through both reads', async () => {
    const signal = new AbortController().signal;
    const client = clientWith({
      searchStation: vi.fn().mockResolvedValue([nyc127]),
    });
    getTransitClientMock.mockReturnValue(client);
    const { registrations } = captureStationTools();

    const result = await invoke(
      tool(registrations, 'get_station_predictions'),
      { city: 'nyc', stationName: 'Times Square' },
      requestContext({ signal }),
    );

    expect(client.searchStation).toHaveBeenCalledWith('Times Square', signal);
    expect(client.getStationPredictions).toHaveBeenCalledWith('127', signal);
    expect(result).toMatchObject({
      structuredContent: { city: 'nyc', station: '127', predictions: [] },
    });
  });

  it('returns the existing no-match error instead of selecting a station', async () => {
    getTransitClientMock.mockReturnValue(clientWith());
    const { registrations } = captureStationTools();

    await expect(invoke(
      tool(registrations, 'get_station_predictions'),
      { city: 'nyc', stationName: 'Missing Place' },
    )).rejects.toThrow('Error: No station found matching: Missing Place');
  });

  it('normalizes upstream failures and supplies the request signal to the wrapper', async () => {
    const signal = new AbortController().signal;
    const client = clientWith({
      getStationPredictions: vi.fn().mockRejectedValue(
        new TransitError('service unavailable', 503, 'dc'),
      ),
    });
    getTransitClientMock.mockReturnValue(client);
    const { registrations } = captureStationTools();

    await expect(invoke(
      tool(registrations, 'get_station_predictions'),
      { city: 'dc', stationName: 'A01' },
      requestContext({ signal }),
    )).rejects.toThrow('Transit API Error [DC] (503): service unavailable');
  });

  it('preserves search, line, all-stations, and transfer structured outputs with signals', async () => {
    const signal = new AbortController().signal;
    const client = clientWith({
      searchStation: vi.fn().mockResolvedValue([dcA01]),
      getStationsByLine: vi.fn().mockResolvedValue([dcA01]),
      getStations: vi.fn().mockResolvedValue([nyc127]),
    });
    getTransitClientMock.mockReturnValue(client);
    const { registrations } = captureStationTools();
    const context = requestContext({ signal });

    const search = await invoke(
      tool(registrations, 'search_stations'),
      { city: 'dc', query: 'Metro' },
      context,
    );
    const byLine = await invoke(
      tool(registrations, 'get_stations_by_line'),
      { city: 'dc', lineCode: 'RD' },
      context,
    );
    const all = await invoke(
      tool(registrations, 'get_all_stations'),
      { city: 'nyc' },
      context,
    );
    const transfers = await invoke(
      tool(registrations, 'get_station_transfers'),
      { city: 'nyc', stationId: '127' },
      context,
    );

    const dcItem = {
      id: 'A01',
      name: 'Metro Center',
      lines: ['RD', 'BL', 'OR', 'SV'],
      coordinates: { lat: 38.898303, lon: -77.028099 },
      address: dcA01.address,
    };
    const nycItem = {
      id: '127',
      name: 'Times Square - 42 St',
      lines: ['1', '2', '3'],
      coordinates: { lat: 40.755983, lon: -73.987495 },
      address: nyc127.address,
    };
    expect(search).toMatchObject({
      structuredContent: { city: 'dc', query: 'Metro', results: [dcItem] },
    });
    expect(byLine).toMatchObject({
      structuredContent: { city: 'dc', line: 'RD', stations: [dcItem] },
    });
    expect(all).toMatchObject({
      structuredContent: { city: 'nyc', totalStations: 1, stations: [nycItem] },
    });
    expect(transfers).toMatchObject({
      structuredContent: {
        city: 'nyc',
        stationId: '127',
        stationName: 'Times Square - 42 St',
        totalTransfers: 1,
        transfers: [{
          toStationId: 'R16',
          toStationName: 'Times Square - 42 St',
          walkTimeSeconds: 75,
          walkTimeMinutes: 2,
          transferType: 'platform',
        }],
      },
    });
    expect(client.searchStation).toHaveBeenCalledWith('Metro', signal);
    expect(client.getStationsByLine).toHaveBeenCalledWith('RD', signal);
    expect(client.getStations).toHaveBeenNthCalledWith(1, signal);
    expect(client.getStations).toHaveBeenNthCalledWith(2, signal);
  });

  it('emits 0/2 and 1/2 progress before the final all-stations result only when tokened', async () => {
    const events: string[] = [];
    const client = clientWith({
      getStations: vi.fn().mockImplementation(async () => {
        events.push('fetch');
        return [dcA01];
      }),
    });
    getTransitClientMock.mockReturnValue(client);
    const { registrations } = captureStationTools();
    const notify = vi.fn().mockImplementation(async notification => {
      events.push(`progress:${notification.params.progress}`);
    });

    const result = await invoke(
      tool(registrations, 'get_all_stations'),
      { city: 'dc' },
      requestContext({ progressToken: 'progress-1', notify }),
    );
    events.push('result');

    expect(events).toEqual(['progress:0', 'fetch', 'progress:1', 'result']);
    expect(notify).toHaveBeenNthCalledWith(1, {
      method: 'notifications/progress',
      params: {
        progressToken: 'progress-1',
        progress: 0,
        total: 2,
        message: 'Fetching DC stations…',
      },
    });
    expect(notify).toHaveBeenNthCalledWith(2, {
      method: 'notifications/progress',
      params: {
        progressToken: 'progress-1',
        progress: 1,
        total: 2,
        message: 'Normalizing 1 stations…',
      },
    });
    expect(result).toMatchObject({
      structuredContent: { city: 'dc', totalStations: 1 },
    });

    notify.mockClear();
    await invoke(
      tool(registrations, 'get_all_stations'),
      { city: 'dc' },
      requestContext({ notify }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('stops progress and the final result when all-stations fetch is cancelled', async () => {
    const controller = new AbortController();
    const reason = new DOMException('request closed', 'AbortError');
    const client = clientWith({
      getStations: vi.fn().mockImplementation(async () => {
        controller.abort(reason);
        return [dcA01];
      }),
    });
    getTransitClientMock.mockReturnValue(client);
    const { registrations } = captureStationTools();
    const notify = vi.fn().mockResolvedValue(undefined);

    await expect(invoke(
      tool(registrations, 'get_all_stations'),
      { city: 'dc' },
      requestContext({
        signal: controller.signal,
        progressToken: 'progress-1',
        notify,
      }),
    )).rejects.toBe(reason);

    expect(client.getStations).toHaveBeenCalledWith(controller.signal);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ progress: 0 }),
    }));
  });

  it('does not fetch stations when cancellation occurs during 0/2 progress', async () => {
    const controller = new AbortController();
    const reason = new Error('request closed during initial progress');
    reason.name = 'RequestClosed';
    const client = clientWith({
      getStations: vi.fn().mockResolvedValue([dcA01]),
    });
    getTransitClientMock.mockReturnValue(client);
    const { registrations } = captureStationTools();
    const notify = vi.fn().mockImplementation(async notification => {
      if (notification.params.progress === 0) controller.abort(reason);
    });

    await expect(invoke(
      tool(registrations, 'get_all_stations'),
      { city: 'dc' },
      requestContext({
        signal: controller.signal,
        progressToken: 'progress-0-abort',
        notify,
      }),
    )).rejects.toBe(reason);

    expect(controller.signal.reason).toBe(reason);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(client.getStations).not.toHaveBeenCalled();
  });

  it('does not return a final result when cancellation occurs during 1/2 progress', async () => {
    const controller = new AbortController();
    const reason = new Error('request closed during final progress');
    reason.name = 'RequestClosed';
    const events: string[] = [];
    const client = clientWith({
      getStations: vi.fn().mockResolvedValue([dcA01]),
    });
    getTransitClientMock.mockReturnValue(client);
    const { registrations } = captureStationTools();
    const notify = vi.fn().mockImplementation(async notification => {
      events.push(`progress:${notification.params.progress}`);
      if (notification.params.progress === 1) controller.abort(reason);
    });

    const result = invoke(
      tool(registrations, 'get_all_stations'),
      { city: 'dc' },
      requestContext({
        signal: controller.signal,
        progressToken: 'progress-1-abort',
        notify,
      }),
    ).then(value => {
      events.push('result');
      return value;
    });

    await expect(result).rejects.toBe(reason);
    expect(controller.signal.reason).toBe(reason);
    expect(client.getStations).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['progress:0', 'progress:1']);
  });
});

describe('station MRTR state machine', () => {
  function ambiguousSetup(era: MetroMcpContext['era'] = 'modern', userId = 'user-42') {
    const context = metroContext(era, userId);
    const stateCodec = stateCodecFor(context);
    const captured = captureStationTools(context, stateCodec);
    const client = clientWith({
      searchStation: vi.fn().mockResolvedValue([nyc127, nycR16]),
    });
    getTransitClientMock.mockReturnValue(client);
    return {
      ...captured,
      client,
      prediction: tool(captured.registrations, 'get_station_predictions'),
    };
  }

  it('returns signed input_required for a modern ambiguous match', async () => {
    const { prediction } = ambiguousSetup();

    const result = await invoke(
      prediction,
      { city: 'nyc', stationName: 'Times Square' },
    ) as Record<string, any>;

    expect(result).toMatchObject({
      resultType: 'input_required',
      inputRequests: { station: { method: 'elicitation/create' } },
    });
    expect(result.requestState).toMatch(/^v1\./);
    expect(result.inputRequests.station.params.message).toBe(
      'Multiple stations match "Times Square". Choose one.',
    );
    expect(result.inputRequests.station.params.requestedSchema).toMatchObject({
      type: 'object',
      properties: {
        stationId: {
          enum: ['127', 'R16'],
          description: '127 — Times Square - 42 St; R16 — Times Square - Broadway',
        },
      },
      required: ['stationId'],
    });
    const envelope = decodeStateEnvelope(result.requestState) as Record<string, any>;
    expect(envelope.p).toEqual({
      phase: 'station-selection',
      tool: 'get_station_predictions',
      city: 'nyc',
      query: 'times square',
      candidateIds: ['127', 'R16'],
    });
    expect(JSON.stringify(envelope)).not.toContain('user-42');
    expect(JSON.stringify(envelope)).not.toContain('Times Square -');
  });

  it('returns candidate retry guidance to a 2025 stateless client', async () => {
    const { prediction } = ambiguousSetup('legacy');

    const result = await invoke(
      prediction,
      { city: 'nyc', stationName: 'Times Square' },
    ) as Record<string, any>;

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('127');
    expect(result.content[0].text).toContain('R16');
    expect(result.content[0].text).toContain('call get_station_predictions again');
    expect(result.content[0].text).toContain('exact station ID');
  });

  it('accepts a selected candidate and fetches only that station', async () => {
    const { prediction, stateCodec, client } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec);

    const result = await invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      inputResponses: {
        station: { action: 'accept', content: { stationId: 'R16' } },
      },
    });

    expect(client.searchStation).not.toHaveBeenCalled();
    expect(client.getStationPredictions).toHaveBeenCalledWith(
      'R16',
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({
      structuredContent: { city: 'nyc', station: 'R16', predictions: [] },
    });
  });

  it.each([
    ['decline', 'declined'],
    ['cancel', 'cancelled'],
  ] as const)('returns a readable non-retryable result when selection is %s', async (action, outcome) => {
    const { prediction, stateCodec, client } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec);

    const result = await invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      inputResponses: { station: { action } },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: `Station selection ${outcome} by user` }],
      isError: true,
    });
    expect(client.getStationPredictions).not.toHaveBeenCalled();
  });

  it.each([
    ['missing station response', undefined],
    ['missing accepted content', { station: { action: 'accept' } }],
    ['missing station ID', { station: { action: 'accept', content: {} } }],
    ['wrong station ID type', {
      station: { action: 'accept', content: { stationId: 127 } },
    }],
    ['unknown action', {
      station: { action: 'later', content: { stationId: '127' } },
    }],
    ['wrong response kind', {
      station: { roots: [] },
    }],
  ])('rejects malformed accepted content: %s', async (_label, inputResponses) => {
    const { prediction, stateCodec } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec);

    await expect(invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      inputResponses,
    })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Invalid station selection',
    });
  });

  it('rejects an accepted station outside the signed candidate list', async () => {
    const { prediction, stateCodec } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec);

    await expect(invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      inputResponses: {
        station: { action: 'accept', content: { stationId: '725' } },
      },
    })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Invalid station selection',
    });
  });

  it('rejects duplicate candidate IDs inside an otherwise valid signed payload', async () => {
    const { prediction, stateCodec } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec, requestContext(), {
      candidateIds: ['127', '127'],
    });

    await expect(invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      inputResponses: {
        station: { action: 'accept', content: { stationId: '127' } },
      },
    })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Station selection state does not match this request',
    });
  });

  it('rejects duplicate candidate IDs before minting request state', async () => {
    const { prediction, client } = ambiguousSetup();
    vi.mocked(client.searchStation).mockResolvedValue([nyc127, { ...nycR16, id: '127' }]);

    await expect(invoke(
      prediction,
      { city: 'nyc', stationName: 'Times Square' },
    )).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Ambiguous station matches contain duplicate candidate IDs',
    });
  });

  it('rejects an expired signed state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
    const { stateCodec } = ambiguousSetup();
    const context = requestContext();
    const wireState = await mintSelectionState(stateCodec, context);
    vi.setSystemTime(new Date('2026-08-13T12:05:01.000Z'));

    await expect(stateCodec.verify(wireState, context)).rejects.toThrow('expired');
  });

  it('rejects a tampered state MAC', async () => {
    const { stateCodec } = ambiguousSetup();
    const context = requestContext();
    const wireState = await mintSelectionState(stateCodec, context);
    const [version, payload, mac] = wireState.split('.');
    if (!version || !payload || !mac) throw new Error('Malformed test state');
    const replacement = mac.startsWith('a') ? 'b' : 'a';
    const tampered = `${version}.${payload}.${replacement}${mac.slice(1)}`;

    await expect(stateCodec.verify(tampered, context)).rejects.toThrow('mac');
  });

  it('rejects cross-user state replay', async () => {
    const first = ambiguousSetup('modern', 'user-42');
    const second = ambiguousSetup('modern', 'user-99');
    const context = requestContext();
    const wireState = await mintSelectionState(first.stateCodec, context);

    await expect(second.stateCodec.verify(wireState, context)).rejects.toThrow('bind');
  });

  it('rejects state replay under another MCP method', async () => {
    const { stateCodec } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec, requestContext());

    await expect(stateCodec.verify(
      wireState,
      requestContext({ method: 'prompts/get' }),
    )).rejects.toThrow('bind');
  });

  it.each([
    ['city', { city: 'dc', stationName: 'Times Square' }],
    ['query', { city: 'nyc', stationName: '  Other   Station ' }],
  ])('rejects a retry whose %s differs from signed state', async (_label, args) => {
    const { prediction, stateCodec } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec);

    await expect(invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      args,
      inputResponses: {
        station: { action: 'accept', content: { stationId: '127' } },
      },
    })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Station selection state does not match this request',
    });
  });

  it('accepts equivalent query whitespace and casing on retry', async () => {
    const { prediction, stateCodec } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec);

    const result = await invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      args: { city: 'nyc', stationName: '  TIMES   SQUARE  ' },
      inputResponses: {
        station: { action: 'accept', content: { stationId: '127' } },
      },
    });

    expect(result).toMatchObject({ structuredContent: { station: '127' } });
  });

  it('rejects a signed payload for the wrong tool', async () => {
    const { prediction, stateCodec } = ambiguousSetup();
    const wireState = await stateCodec.mint({
      phase: 'station-selection',
      tool: 'search_stations',
      city: 'nyc',
      query: 'times square',
      candidateIds: ['127', 'R16'],
    } as unknown as MetroRequestState, requestContext());

    await expect(invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      inputResponses: {
        station: { action: 'accept', content: { stationId: '127' } },
      },
    })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Station selection state does not match this request',
    });
  });

  it('allows valid read-only replay within five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
    const { prediction, stateCodec, client } = ambiguousSetup();
    const wireState = await mintSelectionState(stateCodec);
    const retry = () => invokeRetry({
      registration: prediction,
      codec: stateCodec,
      wireState,
      inputResponses: {
        station: { action: 'accept', content: { stationId: '127' } },
      },
    });

    await expect(retry()).resolves.toMatchObject({
      structuredContent: { station: '127' },
    });
    vi.setSystemTime(new Date('2026-08-13T12:04:59.000Z'));
    await expect(retry()).resolves.toMatchObject({
      structuredContent: { station: '127' },
    });
    expect(client.getStationPredictions).toHaveBeenCalledTimes(2);
  });
});
