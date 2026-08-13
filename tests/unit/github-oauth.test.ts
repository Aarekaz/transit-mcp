import type {
  AuthRequest,
  ClientInfo,
  CompleteAuthorizationOptions,
} from '@cloudflare/workers-oauth-provider';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  handleAuthorizationDecision,
  handleAuthorize,
  handleGitHubCallback,
} from '../../src/oauth/github-handler';
import type { Env } from '../../src/types';
import { createMockEnv, createMockOAuthHelpers } from '../setup';

const ORIGIN = 'https://metro-mcp.anuragd.me';
const RESOURCE_URI = `${ORIGIN}/mcp`;
const CLIENT_REDIRECT_URI = 'https://client.example/callback';
const CONSENT_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const parsedAuthRequest: AuthRequest = {
  responseType: 'code',
  clientId: 'client-123',
  redirectUri: CLIENT_REDIRECT_URI,
  scope: ['profile', 'transit:read', 'transit:read'],
  state: 'mcp-client-state',
  codeChallenge: 'pkce-challenge',
  codeChallengeMethod: 'S256',
  resource: RESOURCE_URI,
  issuer: ORIGIN,
};

const providerClient: ClientInfo = {
  clientId: 'client-123',
  clientSecret: undefined,
  redirectUris: [CLIENT_REDIRECT_URI],
  clientName: 'Client <script>alert(1)</script>',
  logoUri: undefined,
  clientUri: undefined,
  policyUri: undefined,
  tosUri: undefined,
  jwksUri: undefined,
  i18n: undefined,
  contacts: undefined,
  grantTypes: ['authorization_code'],
  responseTypes: ['code'],
  registrationDate: 1_786_600_800,
  tokenEndpointAuthMethod: 'none',
};

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function createTrackedKv() {
  const entries = new Map<string, string>();
  const puts: KvPut[] = [];
  const events: string[] = [];
  const kv = {
    get: vi.fn(async (key: string) => {
      events.push(`get:${key}`);
      return entries.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      events.push(`put:${key}`);
      entries.set(key, value);
      puts.push({ key, value, options });
    }),
    delete: vi.fn(async (key: string) => {
      events.push(`delete:${key}`);
      entries.delete(key);
    }),
    list: vi.fn(async () => ({
      keys: [...entries.keys()].map(name => ({ name })),
      list_complete: true,
      cursor: '',
    })),
  } as unknown as KVNamespace;
  return { kv, entries, puts, events };
}

function base64UrlByteLength(value: string): number {
  return Buffer.from(value, 'base64url').byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createHarness(overrides: {
  authRequest?: AuthRequest;
  client?: ClientInfo | null;
  completeRedirect?: string;
  environment?: Env['ENVIRONMENT'];
  origin?: string;
} = {}) {
  const tracked = createTrackedKv();
  const authRequest = structuredClone(overrides.authRequest ?? parsedAuthRequest);
  const client = overrides.client === undefined ? structuredClone(providerClient) : overrides.client;
  const parseAuthRequest = vi.fn(async () => structuredClone(authRequest));
  const lookupClient = vi.fn(async () => client ? structuredClone(client) : null);
  const completeAuthorization = vi.fn(async (_options: CompleteAuthorizationOptions) => {
    tracked.events.push('completeAuthorization');
    return { redirectTo: overrides.completeRedirect ?? `${CLIENT_REDIRECT_URI}?code=provider-code` };
  });
  const env = createMockEnv({
    MCP_PUBLIC_ORIGIN: overrides.origin ?? ORIGIN,
    OAUTH_REDIRECT_URI: `${overrides.origin ?? ORIGIN}/callback`,
    ENVIRONMENT: overrides.environment ?? 'production',
    OAUTH_KV: tracked.kv,
    OAUTH_PROVIDER: createMockOAuthHelpers({
      parseAuthRequest,
      lookupClient,
      completeAuthorization,
    }),
  });

  return {
    ...tracked,
    env,
    parseAuthRequest,
    lookupClient,
    completeAuthorization,
  };
}

function authorizeRequest(): Request {
  return new Request(`${ORIGIN}/authorize?client_id=untrusted-input`);
}

function callbackRequest(state: string): Request {
  return new Request(`${ORIGIN}/callback?code=github-code&state=${encodeURIComponent(state)}`);
}

function decisionRequest(state: string, cookie: string, decision: 'approve' | 'deny'): Request {
  return new Request(`${ORIGIN}/authorize/decision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: new URLSearchParams({
      state,
      decision,
      redirect_uri: 'https://attacker.example/callback',
    }),
  });
}

function stubSuccessfulGitHub(events: string[], user: Record<string, unknown> = {
  id: 42,
  login: 'anurag</div><script>alert(2)</script>',
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    events.push(`fetch:${url}`);
    if (url === 'https://github.com/login/oauth/access_token') {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ Accept: 'application/json' });
      return Response.json({ access_token: 'github-access-token', token_type: 'bearer', scope: '' });
    }
    if (url === 'https://api.github.com/user') {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer github-access-token',
        Accept: 'application/vnd.github+json',
      });
      return Response.json(user);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function beginAuthorization(harness: ReturnType<typeof createHarness>) {
  const response = await handleAuthorize(authorizeRequest(), harness.env);
  const location = response.headers.get('location');
  if (!location) throw new Error('Expected GitHub redirect');
  const state = new URL(location).searchParams.get('state');
  if (!state) throw new Error('Expected GitHub state');
  return { response, state };
}

async function reachConsent(harness: ReturnType<typeof createHarness>) {
  const { state: githubState } = await beginAuthorization(harness);
  const fetchMock = stubSuccessfulGitHub(harness.events);
  const response = await handleGitHubCallback(callbackRequest(githubState), harness.env);
  const html = await response.text();
  const stateMatch = html.match(/name="state" value="([^"]+)"/);
  if (!stateMatch?.[1]) throw new Error('Expected hidden consent state');
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Expected consent cookie');
  return { response, html, consentState: stateMatch[1], setCookie, fetchMock, githubState };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub OAuth authorization', () => {
  it('validates through provider helpers before issuing a minimal GitHub redirect', async () => {
    const harness = createHarness();
    const { response, state } = await beginAuthorization(harness);

    expect(response.status).toBe(302);
    expect(harness.parseAuthRequest).toHaveBeenCalledOnce();
    expect(harness.parseAuthRequest).toHaveBeenCalledWith(expect.any(Request));
    expect(harness.lookupClient).toHaveBeenCalledWith('client-123');
    expect(harness.parseAuthRequest.mock.invocationCallOrder[0])
      .toBeLessThan(harness.lookupClient.mock.invocationCallOrder[0]!);

    const githubUrl = new URL(response.headers.get('location')!);
    expect(`${githubUrl.origin}${githubUrl.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(githubUrl.searchParams.get('client_id')).toBe('test-client-id');
    expect(githubUrl.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
    expect(githubUrl.searchParams.get('state')).toBe(state);
    expect(githubUrl.searchParams.has('scope')).toBe(false);

    expect(base64UrlByteLength(state)).toBe(32);
    expect(harness.puts).toHaveLength(1);
    const stored = harness.puts[0]!;
    expect(stored.key).toBe(`app:github-state:${await sha256Hex(state)}`);
    expect(stored.key).not.toContain(state);
    expect(stored.key).toMatch(/^app:github-state:[a-f0-9]{64}$/);
    expect(stored.options?.expirationTtl).toBeGreaterThan(0);
    expect(stored.options?.expirationTtl).toBeLessThanOrEqual(600);
    expect(JSON.parse(stored.value)).toEqual({
      authRequest: {
        ...parsedAuthRequest,
        resource: RESOURCE_URI,
        scope: ['transit:read'],
      },
      clientName: providerClient.clientName,
      createdAt: expect.any(Number),
    });
  });

  it.each([
    ['provider validation failure', new Error('invalid redirect'), providerClient],
    ['unknown client', undefined, null],
  ])('renders %s locally without an external redirect', async (_label, parseError, client) => {
    const harness = createHarness({ client });
    if (parseError) harness.parseAuthRequest.mockRejectedValueOnce(parseError);

    const response = await handleAuthorize(authorizeRequest(), harness.env);

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(harness.puts).toHaveLength(0);
  });

  it('rejects a noncanonical parsed resource locally', async () => {
    const harness = createHarness({
      authRequest: { ...parsedAuthRequest, resource: `${ORIGIN}/sse` },
    });

    const response = await handleAuthorize(authorizeRequest(), harness.env);

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(harness.puts).toHaveLength(0);
  });
});

describe('GitHub callback and consent', () => {
  it('consumes login state before exchange and creates an independent one-time consent state', async () => {
    const harness = createHarness();
    const { response, consentState, githubState, fetchMock } = await reachConsent(harness);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const githubKey = `app:github-state:${await sha256Hex(githubState)}`;
    expect(harness.events.indexOf(`delete:${githubKey}`))
      .toBeLessThan(harness.events.indexOf('fetch:https://github.com/login/oauth/access_token'));
    expect(base64UrlByteLength(consentState)).toBe(32);
    expect(consentState).not.toBe(githubState);
    const consentPut = harness.puts.find(put => put.key.startsWith('app:consent-state:'));
    expect(consentPut?.key).toBe(`app:consent-state:${await sha256Hex(consentState)}`);
    expect(consentPut?.key).not.toContain(consentState);
    expect(consentPut?.options?.expirationTtl).toBeLessThanOrEqual(600);
    expect([...harness.entries.values()].join('\n')).not.toContain('github-access-token');

    const replay = await handleGitHubCallback(callbackRequest(githubState), harness.env);
    expect(replay.status).toBe(400);
    expect(replay.headers.get('location')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('escapes identity/client text and emits the exact consent security policy', async () => {
    const harness = createHarness();
    const { response, html, consentState, setCookie } = await reachConsent(harness);

    expect(html).toContain('Client &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('anurag&lt;/div&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain(RESOURCE_URI);
    expect(html.match(/transit:read/g)).toHaveLength(1);
    expect(html).toContain(`name="state" value="${consentState}"`);
    expect(response.headers.get('content-security-policy')).toBe(CONSENT_CSP);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(setCookie).toBe(
      `__Host-metro-consent=${await sha256Hex(consentState)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
  });

  it('uses an explicit loopback-only cookie accommodation for local HTTP development', async () => {
    const localOrigin = 'http://localhost:8787';
    const harness = createHarness({
      environment: 'development',
      origin: localOrigin,
      authRequest: {
        ...parsedAuthRequest,
        resource: `${localOrigin}/mcp`,
        issuer: localOrigin,
      },
    });
    const { setCookie } = await reachConsent(harness);

    expect(setCookie).toMatch(/^metro-consent=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain('__Host-');
  });

  it.each([
    ['GitHub token endpoint failure', Response.json({ error: 'bad_verification_code' }, { status: 400 })],
    ['GitHub token missing', Response.json({ token_type: 'bearer' })],
  ])('fails %s locally after consuming state', async (_label, exchangeResponse) => {
    const harness = createHarness();
    const { state } = await beginAuthorization(harness);
    const fetchMock = vi.fn().mockResolvedValue(exchangeResponse);
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleGitHubCallback(callbackRequest(state), harness.env);

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(harness.entries.has(`app:github-state:${await sha256Hex(state)}`)).toBe(false);
    expect(harness.puts.filter(put => put.key.startsWith('app:consent-state:'))).toHaveLength(0);
  });

  it.each([
    ['missing user ID', { login: 'anurag' }],
    ['missing login', { id: 42 }],
    ['empty login', { id: 42, login: '' }],
    ['blank login', { id: 42, login: '   ' }],
  ])('fails locally for %s', async (_label, user) => {
    const harness = createHarness();
    const { state } = await beginAuthorization(harness);
    stubSuccessfulGitHub(harness.events, user);

    const response = await handleGitHubCallback(callbackRequest(state), harness.env);

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(harness.puts.filter(put => put.key.startsWith('app:consent-state:'))).toHaveLength(0);
  });
});

describe('explicit authorization decision', () => {
  it('consumes bound consent once and completes approval with exact Provider data', async () => {
    const harness = createHarness();
    const { consentState, setCookie } = await reachConsent(harness);
    const request = decisionRequest(consentState, setCookie.split(';')[0]!, 'approve');

    const response = await handleAuthorizationDecision(request, harness.env);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${CLIENT_REDIRECT_URI}?code=provider-code`);
    expect(response.headers.get('set-cookie')).toBe(
      '__Host-metro-consent=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    );
    expect(harness.completeAuthorization).toHaveBeenCalledWith({
      request: {
        ...parsedAuthRequest,
        resource: RESOURCE_URI,
        scope: ['transit:read'],
      },
      userId: '42',
      metadata: { clientName: providerClient.clientName },
      scope: ['transit:read'],
      props: {
        userId: '42',
        userLogin: 'anurag</div><script>alert(2)</script>',
        clientId: 'client-123',
        scopes: ['transit:read'],
      },
    });
    const consentKey = `app:consent-state:${await sha256Hex(consentState)}`;
    expect(harness.events.indexOf(`delete:${consentKey}`))
      .toBeLessThan(harness.events.indexOf('completeAuthorization'));

    const replay = await handleAuthorizationDecision(request, harness.env);
    expect(replay.status).toBe(400);
    expect(replay.headers.get('location')).toBeNull();
    expect(harness.completeAuthorization).toHaveBeenCalledOnce();
  });

  it('consumes denial and redirects only through the validated pending request', async () => {
    const harness = createHarness();
    const { consentState, setCookie } = await reachConsent(harness);

    const response = await handleAuthorizationDecision(
      decisionRequest(consentState, setCookie.split(';')[0]!, 'deny'),
      harness.env,
    );

    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get('location')!);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLIENT_REDIRECT_URI);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('mcp-client-state');
    expect(redirect.searchParams.get('iss')).toBe(ORIGIN);
    expect(redirect.origin).not.toBe('https://attacker.example');
    expect(harness.completeAuthorization).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it.each([
    ['missing cookie', ''],
    ['wrong cookie', '__Host-metro-consent=wrong-digest'],
  ])('rejects %s locally without consuming the pending consent', async (_label, cookie) => {
    const harness = createHarness();
    const { consentState } = await reachConsent(harness);
    const consentKey = `app:consent-state:${await sha256Hex(consentState)}`;

    const response = await handleAuthorizationDecision(
      decisionRequest(consentState, cookie, 'approve'),
      harness.env,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(harness.entries.has(consentKey)).toBe(true);
    expect(harness.completeAuthorization).not.toHaveBeenCalled();
  });
});
