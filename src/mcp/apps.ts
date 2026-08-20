import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { MetroMcpContext } from './context';
import { PUBLIC_24H } from './shared';

export const TRANSIT_BOARD_URI = 'ui://metro-mcp/transit-board.html';
export const TRANSIT_BOARD_MIME = 'text/html;profile=mcp-app';

const TRANSIT_BOARD_VISIBILITY = Object.freeze(['model', 'app'] as const);

export const TRANSIT_BOARD_TOOL_META = Object.freeze({
  ui: Object.freeze({
    resourceUri: TRANSIT_BOARD_URI,
    visibility: TRANSIT_BOARD_VISIBILITY,
  }),
});

const EMPTY_DOMAINS = Object.freeze([] as string[]);
const TRANSIT_BOARD_RESOURCE_META = Object.freeze({
  ui: Object.freeze({
    csp: Object.freeze({
      connectDomains: EMPTY_DOMAINS,
      resourceDomains: EMPTY_DOMAINS,
      frameDomains: EMPTY_DOMAINS,
      baseUriDomains: EMPTY_DOMAINS,
    }),
    prefersBorder: false,
  }),
});

const TRANSIT_BOARD_ASSET_URL =
  'https://assets.metro-mcp.invalid/apps/transit-board.html';
const TRANSIT_BOARD_ASSET_ERROR =
  'Transit Board application asset is unavailable';

function assetUnavailable(): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    TRANSIT_BOARD_ASSET_ERROR,
  );
}

async function readTransitBoardAsset(context: MetroMcpContext): Promise<string> {
  let response: Response;
  try {
    response = await context.env.ASSETS.fetch(
      new Request(TRANSIT_BOARD_ASSET_URL),
    );
  } catch {
    throw assetUnavailable();
  }

  if (!response.ok) throw assetUnavailable();

  try {
    return await response.text();
  } catch {
    throw assetUnavailable();
  }
}

/** Register the one static MCP Apps resource served by the existing asset binding. */
export function registerTransitBoardApp(
  server: McpServer,
  context: MetroMcpContext,
): void {
  server.registerResource(
    'transit-board-app',
    TRANSIT_BOARD_URI,
    {
      mimeType: TRANSIT_BOARD_MIME,
      _meta: TRANSIT_BOARD_RESOURCE_META,
      cacheHint: PUBLIC_24H,
    },
    async uri => ({
      contents: [{
        uri: uri.href,
        mimeType: TRANSIT_BOARD_MIME,
        text: await readTransitBoardAsset(context),
        _meta: TRANSIT_BOARD_RESOURCE_META,
      }],
    }),
  );
}
