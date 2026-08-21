import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

export const TEST_ORIGIN = 'https://metro-mcp.anuragd.me';
export const TEST_RESOURCE = `${TEST_ORIGIN}/mcp`;
export const TEST_JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';

export type LegacyJwtClaims = {
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  login?: unknown;
  userId?: unknown;
  userLogin?: unknown;
};

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export async function testBearerToken(
  overrides: LegacyJwtClaims = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const claims: LegacyJwtClaims = {
    aud: TEST_RESOURCE,
    exp: now + 3_600,
    sub: 'workerd-user-42',
    login: 'workerd-user',
    ...overrides,
  };
  const header = base64Url(new TextEncoder().encode(JSON.stringify({
    alg: 'HS256',
    typ: 'JWT',
  })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TEST_JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

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
