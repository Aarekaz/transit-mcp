import {
  McpServer,
  createRequestStateCodec,
  type RequestStateCodec,
} from '@modelcontextprotocol/server';
import { SERVER_VERSION } from '../config';
import {
  parseMetroMcpProps,
  requireTransitRead,
  type MetroMcpContext,
  type MetroRequestState,
} from './context';
import { PRIVATE_NO_CACHE, PUBLIC_24H } from './shared';
import { registerStationTools } from './tools/stations';

type MetroFeatureRegistration = (
  server: McpServer,
  context: MetroMcpContext,
  stateCodec: RequestStateCodec<MetroRequestState>,
) => void;

// Tasks 7–8 add their feature registration functions after stations in wire-visible order.
const FEATURE_REGISTRATIONS: readonly MetroFeatureRegistration[] = [
  registerStationTools,
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
  const props = parseMetroMcpProps(requireTransitRead(context.props));
  const normalizedContext: MetroMcpContext = { ...context, props };

  const stateCodec = createRequestStateCodec<MetroRequestState>({
    key: normalizedContext.env.MCP_REQUEST_STATE_KEY,
    ttlSeconds: 300,
    bind: serverContext => [
      normalizedContext.props.userId,
      serverContext.mcpReq.method,
    ].join('\u0000'),
  });

  const server = new McpServer(
    { name: 'metro-mcp', version: SERVER_VERSION },
    {
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

  registerMetroFeatures(server, normalizedContext, stateCodec);
  return { server, stateCodec };
}

/** Build a request-scoped, stateless SDK v2 Metro MCP server. */
export function createMetroMcpServer(context: MetroMcpContext): McpServer {
  return buildMetroMcpServer(context).server;
}
