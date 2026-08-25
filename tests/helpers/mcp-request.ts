import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

export const TEST_ORIGIN = 'https://metro-mcp.anuragd.me';
export const TEST_RESOURCE = `${TEST_ORIGIN}/mcp`;

function namedValue(method: string, params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return undefined;
  }
  const source = method === 'resources/read' ? 'uri' : 'name';
  if (method !== 'tools/call' && method !== 'prompts/get' && method !== 'resources/read') {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[source];
  return typeof value === 'string' ? value : undefined;
}

export function modernEnvelope(
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = 1,
  meta: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
        [CLIENT_INFO_META_KEY]: { name: 'metro-mcp-workerd-tests', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: {},
        ...meta,
      },
    },
  };
}

export async function modernMcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    id?: number | string;
    path?: '/mcp' | '/sse';
    token?: string;
    headers?: HeadersInit;
    meta?: Record<string, unknown>;
  } = {},
): Promise<Request> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  headers.set('Host', 'metro-mcp.anuragd.me');
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json, text/event-stream');
  headers.set('MCP-Protocol-Version', '2026-07-28');
  headers.set('Mcp-Method', method);
  const name = namedValue(method, params);
  if (name) headers.set('Mcp-Name', name);

  return new Request(`${TEST_ORIGIN}${options.path ?? '/mcp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(modernEnvelope(method, params, options.id, options.meta)),
  });
}

export async function legacyMcpRequest(
  method: string,
  params?: Record<string, unknown>,
  options: {
    id?: number | string;
    path?: '/mcp' | '/sse';
    token?: string;
    headers?: HeadersInit;
  } = {},
): Promise<Request> {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  headers.set('Host', 'metro-mcp.anuragd.me');
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json, text/event-stream');
  return new Request(`${TEST_ORIGIN}${options.path ?? '/mcp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}

export async function readMcpResponse(response: Response): Promise<unknown[]> {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return text.length === 0 ? [] : [JSON.parse(text)];
  }

  return text
    .split(/\r?\n\r?\n/)
    .flatMap(event => event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice(5).trim())));
}
