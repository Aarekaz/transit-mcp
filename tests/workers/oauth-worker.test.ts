import { SELF, env, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  modernMcpRequest,
  readMcpResponse,
  testBearerToken,
  TEST_ORIGIN,
  TEST_RESOURCE,
} from '../helpers/mcp-request';

const CLIENT_REDIRECT = 'https://client.example/callback';
const PKCE_VERIFIER = 'metro-mcp-pkce-verifier-with-more-than-43-characters-1234567890';

type RegisteredClient = {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  resource?: string;
};

type PendingAuthorization = {
  client: RegisteredClient;
  verifier: string;
  githubState: string;
  consentState: string;
  consentCookie: string;
};

function oauthRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('Host', 'metro-mcp.anuragd.me');
  return new Request(`${TEST_ORIGIN}${path}`, {
    redirect: 'manual',
    ...init,
    headers,
  });
}

async function oauthFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(oauthRequest(path, init));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function pkceChallenge(verifier = PKCE_VERIFIER): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function registerClient(
  tokenEndpointAuthMethod: 'none' | 'client_secret_basic' = 'none',
): Promise<RegisteredClient> {
  const response = await oauthFetch('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `Workerd ${tokenEndpointAuthMethod} client`,
      redirect_uris: [CLIENT_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    }),
  });
  expect(response.status).toBe(201);
  return await response.json() as RegisteredClient;
}

function authorizationPath(
  clientId: string,
  options: {
    redirectUri?: string;
    method?: 'S256' | 'plain';
    challenge?: string;
    resource?: string;
    state?: string;
  } = {},
): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: options.redirectUri ?? CLIENT_REDIRECT,
    scope: 'transit:read',
    state: options.state ?? 'client-state',
    resource: options.resource ?? TEST_RESOURCE,
  });
  if (options.challenge) query.set('code_challenge', options.challenge);
  if (options.method) query.set('code_challenge_method', options.method);
  return `/authorize?${query}`;
}

function hiddenInput(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  expect(match, `hidden input ${name}`).not.toBeNull();
  return match![1]!;
}

function installOutboundMock(
  handler?: (request: Request) => Response | Promise<Response> | undefined,
): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const custom = await handler?.(request);
    if (custom) return custom;
    if (request.url === 'https://github.com/login/oauth/access_token'
      && request.method === 'POST') {
      return Response.json({ access_token: 'github-test-token' });
    }
    if (request.url === 'https://api.github.com/user' && request.method === 'GET') {
      return Response.json({ id: 42, login: 'workerd-user' });
    }
    throw new Error(`Unmatched outbound request: ${request.method} ${request.url}`);
  });
}

async function beginConsent(
  client: RegisteredClient,
  verifier = PKCE_VERIFIER,
): Promise<PendingAuthorization> {
  const authorize = await oauthFetch(authorizationPath(client.client_id, {
    challenge: await pkceChallenge(verifier),
    method: 'S256',
  }));
  expect(authorize.status).toBe(302);
  const githubLocation = new URL(authorize.headers.get('location')!);
  expect(githubLocation.origin).toBe('https://github.com');
  const githubState = githubLocation.searchParams.get('state');
  expect(githubState).toBeTruthy();

  const callback = await oauthFetch(`/callback?${new URLSearchParams({
    code: 'github-code',
    state: githubState!,
  })}`);
  expect(callback.status).toBe(200);
  const html = await callback.text();
  const setCookie = callback.headers.get('set-cookie');
  expect(setCookie).toContain('__Host-metro-consent=');

  return {
    client,
    verifier,
    githubState: githubState!,
    consentState: hiddenInput(html, 'state'),
    consentCookie: setCookie!.split(';')[0]!,
  };
}

async function decide(
  pending: PendingAuthorization,
  decision: 'approve' | 'deny',
): Promise<Response> {
  return oauthFetch('/authorize/decision', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: pending.consentCookie,
    },
    body: new URLSearchParams({ state: pending.consentState, decision }),
  });
}

async function tokenRequest(params: Record<string, string>): Promise<Response> {
  return oauthFetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

async function approveAndExchange(): Promise<{
  client: RegisteredClient;
  verifier: string;
  tokens: TokenResponse;
}> {
  const client = await registerClient();
  const pending = await beginConsent(client);
  const approval = await decide(pending, 'approve');
  expect(approval.status).toBe(302);
  const redirect = new URL(approval.headers.get('location')!);
  expect(redirect.origin + redirect.pathname).toBe(CLIENT_REDIRECT);
  expect(redirect.searchParams.get('state')).toBe('client-state');
  expect(redirect.searchParams.get('iss')).toBe(TEST_ORIGIN);
  const code = redirect.searchParams.get('code');
  expect(code).toBeTruthy();

  const exchange = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code: code!,
    redirect_uri: CLIENT_REDIRECT,
    code_verifier: pending.verifier,
    resource: TEST_RESOURCE,
  });
  expect(exchange.status).toBe(200);
  return {
    client,
    verifier: pending.verifier,
    tokens: await exchange.json() as TokenResponse,
  };
}

beforeEach(() => {
  installOutboundMock();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

describe('assembled OAuth Provider', () => {
  it('publishes authorization-server and protected-resource discovery', async () => {
    expect(env.OAUTH_KV).toBeDefined();
    const [authorization, resource] = await Promise.all([
      oauthFetch('/.well-known/oauth-authorization-server'),
      oauthFetch('/.well-known/oauth-protected-resource/mcp'),
    ]);

    expect(authorization.status).toBe(200);
    await expect(authorization.json()).resolves.toMatchObject({
      issuer: TEST_ORIGIN,
      authorization_endpoint: `${TEST_ORIGIN}/authorize`,
      token_endpoint: `${TEST_ORIGIN}/token`,
      registration_endpoint: `${TEST_ORIGIN}/register`,
      revocation_endpoint: `${TEST_ORIGIN}/token`,
      scopes_supported: ['transit:read'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    expect(resource.status).toBe(200);
    await expect(resource.json()).resolves.toEqual({
      resource: TEST_RESOURCE,
      authorization_servers: [TEST_ORIGIN],
      scopes_supported: ['transit:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Metro MCP',
    });
  });

  it('keeps DCR as a TTL-bound compatibility fallback with exact redirect matching', async () => {
    const confidential = await registerClient('client_secret_basic');
    expect(confidential.client_secret).toBeTruthy();
    expect(confidential.client_secret_expires_at! - confidential.client_id_issued_at)
      .toBe(7_776_000);

    const wrongRedirect = await oauthFetch(authorizationPath(confidential.client_id, {
      redirectUri: 'https://client.example/other',
      challenge: await pkceChallenge(),
      method: 'S256',
    }));
    expect(wrongRedirect.status).toBe(400);
    expect(await wrongRedirect.text()).toContain('could not be validated');
  });

  it('accepts valid CIMD and rejects unsafe or invalid metadata documents', async () => {
    const clientId = 'https://client.example/metadata.json';
    const validDocument = {
      client_id: clientId,
      client_name: 'CIMD Workerd Client',
      redirect_uris: [CLIENT_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };

    vi.restoreAllMocks();
    installOutboundMock(request => {
      if (request.url === clientId) {
        return Response.json(validDocument, { headers: { 'Cache-Control': 'no-store' } });
      }
      return undefined;
    });
    const valid = await oauthFetch(authorizationPath(clientId, {
      challenge: await pkceChallenge(),
      method: 'S256',
    }));
    expect(valid.status).toBe(302);
    expect(new URL(valid.headers.get('location')!).origin).toBe('https://github.com');

    vi.restoreAllMocks();
    installOutboundMock(request => {
      if (request.url === clientId) {
        return Response.json({ ...validDocument, redirect_uris: ['https://other.example/cb'] });
      }
      return undefined;
    });
    const badRedirect = await oauthFetch(authorizationPath(clientId, {
      challenge: await pkceChallenge(),
      method: 'S256',
    }));
    expect(badRedirect.status).toBe(400);

    for (const unsafeClientId of [
      'http://client.example/metadata.json',
      'https://127.0.0.1/metadata.json',
      'https://localhost/metadata.json',
    ]) {
      const response = await oauthFetch(authorizationPath(unsafeClientId, {
        challenge: await pkceChallenge(),
        method: 'S256',
      }));
      expect(response.status).toBe(400);
    }
  });

  it('rejects oversized and non-JSON CIMD responses', async () => {
    const clientId = 'https://client.example/metadata.json';
    const baseDocument = {
      client_id: clientId,
      client_name: 'CIMD Workerd Client',
      redirect_uris: [CLIENT_REDIRECT],
    };

    for (const responseFactory of [
      () => new Response(JSON.stringify({ ...baseDocument, padding: 'x'.repeat(5_100) }), {
        headers: { 'Content-Type': 'application/json' },
      }),
      () => new Response('<html>not json</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
      () => new Response('{not-json', {
        headers: { 'Content-Type': 'application/json' },
      }),
    ]) {
      vi.restoreAllMocks();
      installOutboundMock(request => request.url === clientId ? responseFactory() : undefined);
      const response = await oauthFetch(authorizationPath(clientId, {
        challenge: await pkceChallenge(),
        method: 'S256',
      }));
      expect(response.status).toBe(400);
    }
  });

  it('bounds CIMD metadata fetches to the Provider timeout', async () => {
    const clientId = 'https://timeout.example/metadata.json';
    vi.restoreAllMocks();
    installOutboundMock(request => {
      if (request.url !== clientId) return undefined;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(request.signal.reason);
        }, { once: true });
      });
    });

    const response = await oauthFetch(authorizationPath(clientId, {
      challenge: await pkceChallenge(),
      method: 'S256',
    }));

    expect(response.status).toBe(400);
  }, 15_000);

  it('requires PKCE S256 for public clients', async () => {
    const client = await registerClient();
    const missing = await oauthFetch(authorizationPath(client.client_id));
    const plain = await oauthFetch(authorizationPath(client.client_id, {
      challenge: PKCE_VERIFIER,
      method: 'plain',
    }));
    expect(missing.status).toBe(400);
    expect(plain.status).toBe(400);

    const pending = await beginConsent(client);
    const approval = await decide(pending, 'approve');
    const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
    const missingVerifier = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: CLIENT_REDIRECT,
      resource: TEST_RESOURCE,
    });
    expect(missingVerifier.status).toBe(400);
    const mismatch = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: CLIENT_REDIRECT,
      code_verifier: `${PKCE_VERIFIER}-wrong`,
      resource: TEST_RESOURCE,
    });
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it('requires explicit GitHub consent, emits RFC 9207 iss, and consumes state once', async () => {
    const approveClient = await registerClient();
    const approvePending = await beginConsent(approveClient);

    const replayedCallbackLocation = await oauthFetch(`/callback?${new URLSearchParams({
      code: 'github-code',
      state: approvePending.githubState,
    })}`);
    expect(replayedCallbackLocation.status).toBe(400);

    const approval = await decide(approvePending, 'approve');
    const approved = new URL(approval.headers.get('location')!);
    expect(approved.searchParams.get('code')).toBeTruthy();
    expect(approved.searchParams.get('state')).toBe('client-state');
    expect(approved.searchParams.get('iss')).toBe(TEST_ORIGIN);
    const replayedDecision = await decide(approvePending, 'approve');
    expect(replayedDecision.status).toBe(400);

    const denyClient = await registerClient();
    const denyPending = await beginConsent(denyClient);
    const denial = await decide(denyPending, 'deny');
    const denied = new URL(denial.headers.get('location')!);
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('state')).toBe('client-state');
    expect(denied.searchParams.get('iss')).toBe(TEST_ORIGIN);
  });

  it('preserves the RFC 8707 resource through exchange, MCP access, and refresh', async () => {
    const { client, tokens } = await approveAndExchange();
    expect(tokens).toMatchObject({
      token_type: 'bearer',
      expires_in: 3_600,
      scope: 'transit:read',
      resource: TEST_RESOURCE,
    });
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();

    const mcp = await SELF.fetch(await modernMcpRequest('server/discover', {}, {
      token: tokens.access_token,
    }));
    expect(mcp.status).toBe(200);
    await expect(readMcpResponse(mcp)).resolves.toHaveLength(1);

    const refresh = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource: TEST_RESOURCE,
    });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.json() as TokenResponse;
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(refreshed.resource).toBe(TEST_RESOURCE);
  });

  it('expires the refresh grant at the configured 30-day boundary', async () => {
    const { client, tokens } = await approveAndExchange();
    const issuedAt = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(issuedAt + 2_592_000_000));

    const expired = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource: TEST_RESOURCE,
    });

    expect(expired.status).toBe(400);
    await expect(expired.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  });

  it('rotates refresh tokens with one retry grace, then revokes the active family', async () => {
    const { client, tokens: first } = await approveAndExchange();
    const refresh = (token: string) => tokenRequest({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: token,
      resource: TEST_RESOURCE,
    });

    const secondResponse = await refresh(first.refresh_token);
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as TokenResponse;
    const retryResponse = await refresh(first.refresh_token);
    expect(retryResponse.status).toBe(200);
    const retry = await retryResponse.json() as TokenResponse;
    expect(retry.refresh_token).not.toBe(first.refresh_token);
    expect(retry.refresh_token).not.toBe(second.refresh_token);
    expect((await refresh(second.refresh_token)).status).toBe(400);

    const thirdResponse = await refresh(retry.refresh_token);
    expect(thirdResponse.status).toBe(200);
    const third = await thirdResponse.json() as TokenResponse;
    expect((await refresh(first.refresh_token)).status).toBe(400);

    const revoke = await tokenRequest({
      token: third.refresh_token,
      token_type_hint: 'refresh_token',
      client_id: client.client_id,
    });
    expect(revoke.status).toBe(200);
    expect((await refresh(third.refresh_token)).status).toBe(400);
    expect((await refresh(retry.refresh_token)).status).toBe(400);

    for (const token of [first.access_token, retry.access_token, third.access_token]) {
      const revokedAccess = await SELF.fetch(await modernMcpRequest('server/discover', {}, {
        token,
      }));
      expect(revokedAccess.status).toBe(401);
    }
  });

  it('accepts only canonical legacy bearer JWTs before the cutoff and never query transport', async () => {
    const canonical = await testBearerToken();
    const accepted = await SELF.fetch(await modernMcpRequest('server/discover', {}, {
      token: canonical,
    }));
    expect(accepted.status).toBe(200);

    for (const token of [
      await testBearerToken({ aud: undefined }),
      await testBearerToken({ aud: `${TEST_ORIGIN}/sse` }),
    ]) {
      const response = await SELF.fetch(await modernMcpRequest('server/discover', {}, { token }));
      expect(response.status).toBe(401);
    }

    const queryOnly = await oauthFetch(`/mcp?access_token=${encodeURIComponent(canonical)}`, {
      method: 'POST',
    });
    expect(queryOnly.status).toBe(401);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-30T00:00:00.000Z'));
    const afterCutoff = await testBearerToken({
      exp: Date.parse('2026-12-01T00:00:00Z') / 1_000,
    });
    const rejected = await SELF.fetch(await modernMcpRequest('server/discover', {}, {
      token: afterCutoff,
    }));
    expect(rejected.status).toBe(401);
  });
});
