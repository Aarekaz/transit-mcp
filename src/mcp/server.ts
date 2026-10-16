import {
  McpServer,
  createRequestStateCodec,
  type RequestStateCodec,
} from '@modelcontextprotocol/server';
import { SERVER_VERSION } from '../config';
import {
  type MetroMcpContext,
  type MetroRequestState,
} from './context';
import { PRIVATE_NO_CACHE, PUBLIC_24H } from './shared';
import {
  TRANSIT_BOARD_MIME,
  registerTransitBoardApp,
} from './apps';
import { registerPrompts } from './prompts';
import { registerResources } from './resources';
import { registerBusTools } from './tools/buses';
import { registerIncidentTools } from './tools/incidents';
import { registerRouteTools } from './tools/routes';
import { registerStationTools } from './tools/stations';
import { registerTrainTools } from './tools/trains';

/** Public identity reported in initialize/discover results and registry listings. */
export const SERVER_IDENTITY = Object.freeze({
  name: 'transit-mcp',
  title: 'Transit MCP',
  version: SERVER_VERSION,
  description:
    'Real-time DC Metro and NYC Subway arrivals, service alerts, stations, and DC buses.',
  websiteUrl: 'https://transitmcp.com',
  icons: Object.freeze([
    Object.freeze({
      src: 'https://transitmcp.com/metro-mcp.png',
      mimeType: 'image/png',
      sizes: Object.freeze(['1024x1024']),
    }),
  ]),
});

/** Model-facing orientation; keep every claim true of the registered tools. */
export const SERVER_INSTRUCTIONS = [
  'Read-only, real-time transit data for the Washington DC Metro (city "dc", WMATA) and the New York City Subway (city "nyc", MTA).',
  'For train arrivals call get_station_predictions with a station name or ID. When a name matches several stations, choose from the candidates offered or call search_stations and retry with the exact station ID.',
  'DC only: get_elevator_incidents, get_train_positions, and the bus tools (get_bus_predictions, get_bus_routes, get_bus_stops, get_bus_positions). NYC only: get_station_transfers and get_route_info.',
  'Prefer search_stations or get_stations_by_line over get_all_stations, which returns every station in a system.',
  'Times are ISO 8601. A null minutesAway means the feed gave a status (arrivalStatus) or a scheduled time instead of a countdown.',
].join('\n');

type MetroFeatureRegistration = (
  server: McpServer,
  context: MetroMcpContext,
  stateCodec: RequestStateCodec<MetroRequestState>,
) => void;

const FEATURE_REGISTRATIONS: readonly MetroFeatureRegistration[] = [
  registerStationTools,
  registerIncidentTools,
  registerBusTools,
  registerTrainTools,
  registerRouteTools,
];

function registerMetroFeatures(
  server: McpServer,
  context: MetroMcpContext,
  stateCodec: RequestStateCodec<MetroRequestState>,
): void {
  for (const registerFeature of FEATURE_REGISTRATIONS) {
    registerFeature(server, context, stateCodec);
  }
}

function buildMetroMcpServer(context: MetroMcpContext): {
  server: McpServer;
  stateCodec: RequestStateCodec<MetroRequestState>;
} {
  const stateCodec = createRequestStateCodec<MetroRequestState>({
    key: context.env.MCP_REQUEST_STATE_KEY,
    ttlSeconds: 300,
    bind: serverContext => serverContext.mcpReq.method,
  });

  const server = new McpServer(
    {
      ...SERVER_IDENTITY,
      icons: SERVER_IDENTITY.icons.map(icon => ({ ...icon, sizes: [...icon.sizes] })),
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: [TRANSIT_BOARD_MIME],
          },
        },
      },
      cacheHints: {
        'server/discover': PUBLIC_24H,
        'tools/list': PUBLIC_24H,
        'prompts/list': PUBLIC_24H,
        'resources/list': PUBLIC_24H,
        'resources/templates/list': PUBLIC_24H,
        'resources/read': PRIVATE_NO_CACHE,
      },
      inputRequired: { legacyShim: false, maxRounds: 1 },
      requestState: { verify: stateCodec.verify },
    },
  );

  registerMetroFeatures(server, context, stateCodec);
  registerTransitBoardApp(server, context);
  registerResources(server, context);
  registerPrompts(server);
  return { server, stateCodec };
}

/** Build a request-scoped, stateless SDK v2 Metro MCP server. */
export function createMetroMcpServer(context: MetroMcpContext): McpServer {
  return buildMetroMcpServer(context).server;
}
