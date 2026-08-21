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
    { name: 'metro-mcp', version: SERVER_VERSION },
    {
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
