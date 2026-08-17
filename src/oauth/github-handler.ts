import type { AuthRequest } from '@cloudflare/workers-oauth-provider';

import type { Env, PendingConsent, PendingGitHubLogin } from '../types';

const TRANSIT_SCOPE = 'transit:read' as const;
const STATE_TTL_SECONDS = 600;
const GITHUB_STATE_PREFIX = 'app:github-state:' as const;
const CONSENT_STATE_PREFIX = 'app:consent-state:' as const;
const PRODUCTION_COOKIE_NAME = '__Host-metro-consent';
const LOCAL_COOKIE_NAME = 'metro-consent';
const CONSENT_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

type StatePrefix = typeof GITHUB_STATE_PREFIX | typeof CONSENT_STATE_PREFIX;

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function putOneTimeState<T>(
  kv: KVNamespace,
  prefix: StatePrefix,
  value: T,
): Promise<string> {
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await sha256(state);
  await kv.put(`${prefix}${digest}`, JSON.stringify(value), {
    expirationTtl: STATE_TTL_SECONDS,
  });
  return state;
}

/**
 * Cloudflare KV has no atomic read-and-delete primitive. Keep these two KV
 * operations adjacent and consume before any external await; a distributed
 * race remains possible until this state moves to a strongly consistent store.
 */
async function consumeOneTimeState(
  kv: KVNamespace,
  prefix: StatePrefix,
  state: string,
): Promise<unknown | null> {
  const digest = await sha256(state);
  const key = `${prefix}${digest}`;
  const encoded = await kv.get(key);
  await kv.delete(key);
  if (!encoded) {
    return null;
  }

  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    return null;
  }
}

function canonicalResource(env: Env): string {
  return `${env.MCP_PUBLIC_ORIGIN}/mcp`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAuthRequest(value: unknown, resourceUri: string): value is AuthRequest {
  if (!isRecord(value)) {
    return false;
  }

  return value.responseType === 'code'
    && typeof value.clientId === 'string'
    && value.clientId.length > 0
    && typeof value.redirectUri === 'string'
    && value.redirectUri.length > 0
    && Array.isArray(value.scope)
    && value.scope.length === 1
    && value.scope[0] === TRANSIT_SCOPE
    && typeof value.state === 'string'
    && value.resource === resourceUri
    && (value.issuer === undefined || typeof value.issuer === 'string')
    && (value.codeChallenge === undefined || typeof value.codeChallenge === 'string')
    && (value.codeChallengeMethod === undefined || typeof value.codeChallengeMethod === 'string');
}

function isFresh(createdAt: unknown): createdAt is number {
  return typeof createdAt === 'number'
    && Number.isFinite(createdAt)
    && createdAt <= Date.now()
    && Date.now() - createdAt < STATE_TTL_SECONDS * 1_000;
}

function parsePendingGitHubLogin(value: unknown, resourceUri: string): PendingGitHubLogin | null {
  if (!isRecord(value)
    || !isAuthRequest(value.authRequest, resourceUri)
    || typeof value.clientName !== 'string'
    || !isFresh(value.createdAt)) {
    return null;
  }
  return value as unknown as PendingGitHubLogin;
}

function parsePendingConsent(value: unknown, resourceUri: string): PendingConsent | null {
  const pending = parsePendingGitHubLogin(value, resourceUri);
  if (!pending || !isRecord((value as Record<string, unknown>).user)) {
    return null;
  }
  const user = (value as Record<string, unknown>).user as Record<string, unknown>;
  if (typeof user.id !== 'string' || user.id.length === 0
    || typeof user.login !== 'string' || user.login.length === 0) {
    return null;
  }
  return value as unknown as PendingConsent;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlHeaders(extra?: HeadersInit, formActionOrigin?: string): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set(
    'Content-Security-Policy',
    formActionOrigin ? `${CONSENT_CSP} ${formActionOrigin}` : CONSENT_CSP,
  );
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

function localError(message: string, status = 400, extraHeaders?: HeadersInit): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization failed</title></head><body><main><h1>Authorization failed</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  return new Response(body, { status, headers: htmlHeaders(extraHeaders) });
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '[::1]';
}

function useLocalCookie(env: Env): boolean {
  try {
    const origin = new URL(env.MCP_PUBLIC_ORIGIN);
    return env.ENVIRONMENT === 'development'
      && origin.protocol === 'http:'
      && isLoopback(origin.hostname);
  } catch {
    return false;
  }
}

function consentCookieName(env: Env): string {
  return useLocalCookie(env) ? LOCAL_COOKIE_NAME : PRODUCTION_COOKIE_NAME;
}

function consentCookie(env: Env, digest: string, maxAge: number): string {
  const secure = useLocalCookie(env) ? '' : '; Secure';
  return `${consentCookieName(env)}=${digest}; Path=/${secure}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearConsentCookie(env: Env): string {
  return consentCookie(env, '', 0);
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
  if (cookie) {
    headers.set('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

function renderConsent(
  pending: PendingConsent,
  state: string,
  stateDigest: string,
  env: Env,
): Response {
  const resourceUri = canonicalResource(env);
  let clientRedirectOrigin: string;
  try {
    const redirectUri = new URL(pending.authRequest.redirectUri);
    if (redirectUri.protocol !== 'http:' && redirectUri.protocol !== 'https:') {
      return localError('Invalid authorization redirect.');
    }
    clientRedirectOrigin = redirectUri.origin;
  } catch {
    return localError('Invalid authorization redirect.');
  }
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorize Metro MCP</title></head><body><main><h1>Authorize Metro MCP</h1><p>Signed in as ${escapeHtml(pending.user.login)}.</p><p>${escapeHtml(pending.clientName)} is requesting access to ${escapeHtml(resourceUri)}.</p><form method="post" action="/authorize/decision"><input type="hidden" name="state" value="${escapeHtml(state)}"><fieldset><legend>Permission</legend><p><code>${TRANSIT_SCOPE}</code></p></fieldset><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`;
  return new Response(body, {
    status: 200,
    headers: htmlHeaders({
      'Set-Cookie': consentCookie(env, stateDigest, STATE_TTL_SECONDS),
    }, clientRedirectOrigin),
  });
}

/** Validate an MCP authorization request before redirecting to GitHub identity. */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  try {
    const parsed = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
    if (!client) {
      return localError('Unknown OAuth client.');
    }

    const resourceUri = canonicalResource(env);
    if (parsed.resource !== resourceUri || !parsed.scope.includes(TRANSIT_SCOPE)) {
      return localError('Invalid OAuth resource or scope.');
    }

    const authRequest: AuthRequest = {
      ...parsed,
      resource: resourceUri,
      scope: [TRANSIT_SCOPE],
    };
    const pending: PendingGitHubLogin = {
      authRequest,
      clientName: client.clientName ?? client.clientId,
      createdAt: Date.now(),
    };
    const state = await putOneTimeState(env.OAUTH_KV, GITHUB_STATE_PREFIX, pending);
    const githubUrl = new URL('https://github.com/login/oauth/authorize');
    githubUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    githubUrl.searchParams.set('redirect_uri', env.OAUTH_REDIRECT_URI);
    githubUrl.searchParams.set('state', state);
    return redirect(githubUrl.toString());
  } catch {
    return localError('The authorization request could not be validated.');
  }
}

async function exchangeGitHubCode(code: string, env: Env): Promise<string | null> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.OAUTH_REDIRECT_URI,
    }),
  });
  if (!response.ok) {
    return null;
  }
  const data: unknown = await response.json();
  return isRecord(data) && typeof data.access_token === 'string' && data.access_token.length > 0
    ? data.access_token
    : null;
}

async function fetchGitHubIdentity(accessToken: string): Promise<PendingConsent['user'] | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Metro-MCP-Server/5.0',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    });
    if (!response.ok) {
      if (attempt === 0 && [502, 503, 504].includes(response.status)) {
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      return null;
    }
    const data: unknown = await response.json();
    if (!isRecord(data)
      || (typeof data.id !== 'string' && typeof data.id !== 'number')
      || String(data.id).length === 0
      || typeof data.login !== 'string'
      || data.login.trim().length === 0) {
      return null;
    }
    return { id: String(data.id), login: data.login.trim() };
  }
  return null;
}

/** Consume the GitHub login state, fetch identity, and render explicit consent. */
export async function handleGitHubCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state) {
    return localError('Invalid or expired authorization state.');
  }

  const stored = await consumeOneTimeState(env.OAUTH_KV, GITHUB_STATE_PREFIX, state);
  const pending = parsePendingGitHubLogin(stored, canonicalResource(env));
  if (!pending) {
    return localError('Invalid or expired authorization state.');
  }
  if (url.searchParams.has('error')) {
    return localError('GitHub authorization was not completed.');
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return localError('GitHub did not return an authorization code.');
  }

  try {
    const accessToken = await exchangeGitHubCode(code, env);
    if (!accessToken) {
      return localError('GitHub authentication failed.');
    }
    const user = await fetchGitHubIdentity(accessToken);
    if (!user) {
      return localError('GitHub returned an invalid identity.');
    }

    const consentPending: PendingConsent = { ...pending, user };
    const consentState = await putOneTimeState(
      env.OAUTH_KV,
      CONSENT_STATE_PREFIX,
      consentPending,
    );
    const consentDigest = await sha256(consentState);
    return renderConsent(consentPending, consentState, consentDigest, env);
  } catch {
    return localError('GitHub authentication failed.');
  }
}

/** Consume explicit approval or denial and finish only the validated grant. */
export async function handleAuthorizationDecision(request: Request, env: Env): Promise<Response> {
  const clearedCookie = clearConsentCookie(env);
  if (request.method !== 'POST') {
    return localError('Method not allowed.', 405, { 'Set-Cookie': clearedCookie });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return localError('Invalid authorization decision.', 400, { 'Set-Cookie': clearedCookie });
  }

  const state = form.get('state');
  const decision = form.get('decision');
  if (typeof state !== 'string' || state.length === 0
    || (decision !== 'approve' && decision !== 'deny')) {
    return localError('Invalid authorization decision.', 400, { 'Set-Cookie': clearedCookie });
  }

  const expectedDigest = await sha256(state);
  const cookieDigest = readCookie(request, consentCookieName(env));
  if (!cookieDigest || !constantTimeEqual(cookieDigest, expectedDigest)) {
    return localError('Invalid authorization decision.', 400, { 'Set-Cookie': clearedCookie });
  }

  const stored = await consumeOneTimeState(env.OAUTH_KV, CONSENT_STATE_PREFIX, state);
  const pending = parsePendingConsent(stored, canonicalResource(env));
  if (!pending) {
    return localError('Invalid or expired authorization state.', 400, {
      'Set-Cookie': clearedCookie,
    });
  }

  if (decision === 'deny') {
    try {
      const denied = new URL(pending.authRequest.redirectUri);
      denied.searchParams.set('error', 'access_denied');
      if (pending.authRequest.state) {
        denied.searchParams.set('state', pending.authRequest.state);
      }
      if (pending.authRequest.issuer) {
        denied.searchParams.set('iss', pending.authRequest.issuer);
      }
      return redirect(denied.toString(), clearedCookie);
    } catch {
      return localError('Invalid authorization redirect.', 400, { 'Set-Cookie': clearedCookie });
    }
  }

  try {
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: pending.authRequest,
      userId: pending.user.id,
      metadata: { clientName: pending.clientName },
      scope: [TRANSIT_SCOPE],
      props: {
        userId: pending.user.id,
        userLogin: pending.user.login,
        clientId: pending.authRequest.clientId,
        scopes: [TRANSIT_SCOPE],
      },
    });
    return redirect(redirectTo, clearedCookie);
  } catch {
    return localError('Authorization could not be completed.', 400, {
      'Set-Cookie': clearedCookie,
    });
  }
}
