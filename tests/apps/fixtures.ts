import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  EXPECTED_TOOL_CONTRACTS,
  EXPECTED_TOOL_NAMES,
} from '../fixtures/mcp-contracts';

export type ToolName = (typeof EXPECTED_TOOL_NAMES)[number];
export type FixtureState = 'ready' | 'empty' | 'error' | 'hostile';
export type VisualFamily = 'arrival' | 'service' | 'network' | 'route' | 'vehicle';

export const TOOL_NAMES = EXPECTED_TOOL_NAMES;
export const HOSTILE_TEXT = '<img src="https://hostile.invalid/pixel" onerror="globalThis.hostileExecuted=true"><script>globalThis.hostileExecuted=true</script>';

export const TOOL_CASES = {
  get_station_predictions: {
    input: { city: 'dc', stationName: 'Metro Center' },
    view: 'rail-arrivals',
    family: 'arrival',
  },
  search_stations: {
    input: { city: 'nyc', query: 'Times Square' },
    view: 'station-search',
    family: 'network',
  },
  get_stations_by_line: {
    input: { city: 'nyc', lineCode: '1' },
    view: 'line-stations',
    family: 'network',
  },
  get_all_stations: {
    input: { city: 'nyc' },
    view: 'station-directory',
    family: 'network',
  },
  get_station_transfers: {
    input: { city: 'nyc', stationId: '127' },
    view: 'station-transfers',
    family: 'network',
  },
  get_incidents: {
    input: { city: 'dc' },
    view: 'service-incidents',
    family: 'service',
  },
  get_elevator_incidents: {
    input: { city: 'dc' },
    view: 'elevator-incidents',
    family: 'service',
  },
  get_bus_predictions: {
    input: { stopId: '1001195' },
    view: 'bus-arrivals',
    family: 'arrival',
  },
  get_bus_routes: {
    input: {},
    view: 'bus-routes',
    family: 'route',
  },
  get_bus_stops: {
    input: { latitude: 38.9, longitude: -77.03, radius: 500 },
    view: 'bus-stops',
    family: 'route',
  },
  get_bus_positions: {
    input: { routeId: '30N' },
    view: 'bus-positions',
    family: 'vehicle',
  },
  get_train_positions: {
    input: {},
    view: 'train-positions',
    family: 'vehicle',
  },
  get_route_info: {
    input: { city: 'nyc', routeId: 'A' },
    view: 'route-detail',
    family: 'route',
  },
} as const satisfies Record<ToolName, {
  input: Readonly<Record<string, unknown>>;
  view: string;
  family: VisualFamily;
}>;

function structuredFor(toolName: ToolName): Record<string, unknown> {
  return structuredClone(
    EXPECTED_TOOL_CONTRACTS[toolName].structuredContent,
  ) as Record<string, unknown>;
}

function emptyStructuredFor(toolName: ToolName): Record<string, unknown> {
  const structured = structuredFor(toolName);
  switch (toolName) {
    case 'get_station_predictions':
    case 'get_bus_predictions':
      return { ...structured, predictions: [] };
    case 'search_stations':
      return { ...structured, results: [] };
    case 'get_stations_by_line':
      return { ...structured, stations: [] };
    case 'get_all_stations':
      return { ...structured, totalStations: 0, stations: [] };
    case 'get_station_transfers':
      return { ...structured, totalTransfers: 0, transfers: [] };
    case 'get_incidents':
      return { ...structured, incidents: [] };
    case 'get_elevator_incidents':
      return { ...structured, elevatorIncidents: [] };
    case 'get_bus_routes':
      return { ...structured, totalRoutes: 0, routes: [] };
    case 'get_bus_stops':
      return { ...structured, totalStops: 0, stops: [] };
    case 'get_bus_positions':
      return { ...structured, totalBuses: 0, buses: [] };
    case 'get_train_positions':
      return { ...structured, totalTrains: 0, trains: [] };
    case 'get_route_info':
      return {
        city: 'nyc',
        routeId: '',
        shortName: '',
        longName: '',
        description: '',
      };
  }
}

function hostileStructuredFor(toolName: ToolName): Record<string, unknown> {
  if (toolName !== 'get_incidents') {
    return structuredFor(toolName);
  }
  const structured = structuredFor(toolName);
  const incidents = structured.incidents as Record<string, unknown>[];
  return {
    ...structured,
    incidents: [{ ...incidents[0], description: HOSTILE_TEXT }],
  };
}

function successfulResult(structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function resultFor(toolName: ToolName, state: FixtureState): CallToolResult {
  if (state === 'error') {
    return {
      content: [{ type: 'text', text: 'Fixture transit provider unavailable.' }],
      isError: true,
    };
  }
  if (state === 'empty') {
    return successfulResult(emptyStructuredFor(toolName));
  }
  if (state === 'hostile') {
    return successfulResult(hostileStructuredFor(toolName));
  }
  return successfulResult(structuredFor(toolName));
}
