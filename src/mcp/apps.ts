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

const TRANSIT_BOARD_ASSET_PATH = '/apps/transit-board.html';
const MAX_TRANSIT_BOARD_ASSET_BYTES = 1_048_576;
const TRANSIT_BOARD_ASSET_ERROR =
  'Transit Board application asset is unavailable';

function assetUnavailable(): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    TRANSIT_BOARD_ASSET_ERROR,
  );
}

function declaredAssetIsTooLarge(response: Response): boolean {
  const value = response.headers.get('content-length')?.trim();
  if (!value || !/^\d+$/.test(value)) return false;

  const length = Number(value);
  return !Number.isSafeInteger(length) || length > MAX_TRANSIT_BOARD_ASSET_BYTES;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // The public error is intentionally independent of upstream cancellation.
  }
}

async function readBoundedUtf8Body(response: Response): Promise<string> {
  if (declaredAssetIsTooLarge(response)) {
    await cancelBody(response.body);
    throw assetUnavailable();
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_TRANSIT_BOARD_ASSET_BYTES - byteLength) {
        throw assetUnavailable();
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The public error is intentionally independent of upstream cancellation.
    }
    throw assetUnavailable();
  } finally {
    reader.releaseLock();
  }
}

async function readTransitBoardAsset(context: MetroMcpContext): Promise<string> {
  let response: Response;
  try {
    const assetUrl = new URL(
      TRANSIT_BOARD_ASSET_PATH,
      context.env.MCP_PUBLIC_ORIGIN,
    );
    response = await context.env.ASSETS.fetch(
      new Request(assetUrl),
    );
  } catch {
    throw assetUnavailable();
  }

  if (!response.ok) throw assetUnavailable();

  try {
    return await readBoundedUtf8Body(response);
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
