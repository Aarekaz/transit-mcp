import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthManager } from '../../src/auth';
import { resolveLegacyToken } from '../../src/oauth/legacy-token';
import { createMockEnv } from '../setup';

const RESOURCE_URI = 'https://metro-mcp.anuragd.me/mcp';
const CUTOFF = '2026-11-30T00:00:00.000Z';
const SECRET = 'test-jwt-secret-at-least-32-characters-long';

type LegacyClaims = {
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  login?: unknown;
  userId?: unknown;
  userLogin?: unknown;
};

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function legacyJwt(
  overrides: LegacyClaims = {},
  secret = SECRET,
  headerClaims: unknown = { alg: 'HS256', typ: 'JWT' },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: LegacyClaims = {
    aud: RESOURCE_URI,
    exp: now + 3_600,
    sub: '42',
    login: 'anurag',
    ...overrides,
  };
  const header = base64Url(new TextEncoder().encode(JSON.stringify(headerClaims)));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

describe('legacy OAuth token resolver', () => {
  const env = createMockEnv({ JWT_SECRET: SECRET });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps a valid canonical legacy JWT into normalized external-token props', async () => {
    await expect(resolveLegacyToken(await legacyJwt(), env, RESOURCE_URI)).resolves.toEqual({
      audience: RESOURCE_URI,
      props: {
        userId: '42',
        userLogin: 'anurag',
        clientId: 'legacy-jwt',
        scopes: ['transit:read'],
      },
    });
  });

  it('accepts the canonical claim pair emitted by the retained AuthManager', async () => {
    const token = await new AuthManager(env).generateJWT({
      userId: ' 42 ',
      userLogin: ' anurag ',
      expiresAt: Date.parse('2026-08-13T13:00:00Z') / 1_000,
      audience: RESOURCE_URI,
    });

    await expect(resolveLegacyToken(token, env, RESOURCE_URI)).resolves.toEqual({
      audience: RESOURCE_URI,
      props: {
        userId: '42',
        userLogin: 'anurag',
        clientId: 'legacy-jwt',
        scopes: ['transit:read'],
      },
    });
  });

  it('accepts both complete historical claim pairs only when normalized values agree', async () => {
    const token = await legacyJwt({
      userId: ' 42 ',
      userLogin: ' anurag ',
    });

    await expect(resolveLegacyToken(token, env, RESOURCE_URI)).resolves.toMatchObject({
      props: { userId: '42', userLogin: 'anurag' },
    });
  });

  it.each([
    ['only deployed userId', { userId: '42' }],
    ['only deployed userLogin', { userLogin: 'anurag' }],
    ['only alternate sub', { sub: '42' }],
    ['only alternate login', { login: 'anurag' }],
    ['alternate sub with deployed userLogin', { sub: '42', userLogin: 'anurag' }],
    ['deployed userId with alternate login', { userId: '42', login: 'anurag' }],
    ['non-string deployed userId', { userId: 42, userLogin: 'anurag' }],
    ['non-string deployed userLogin', { userId: '42', userLogin: 42 }],
    ['blank deployed userId', { userId: '   ', userLogin: 'anurag' }],
    ['blank deployed userLogin', { userId: '42', userLogin: '   ' }],
  ])('rejects incomplete, mixed, or invalid identity pair: %s', async (_label, identity) => {
    const token = await legacyJwt({
      sub: undefined,
      login: undefined,
      userId: undefined,
      userLogin: undefined,
      ...identity,
    });

    await expect(resolveLegacyToken(token, env, RESOURCE_URI)).resolves.toBeNull();
  });

  it.each([
    ['different IDs', { userId: '99', userLogin: 'anurag' }],
    ['different logins', { userId: '42', userLogin: 'other-user' }],
  ])('rejects conflicting complete identity pairs: %s', async (_label, deployedPair) => {
    await expect(resolveLegacyToken(
      await legacyJwt(deployedPair),
      env,
      RESOURCE_URI,
    )).resolves.toBeNull();
  });

  it('accepts exactly one trailing audience slash after URL normalization', async () => {
    await expect(resolveLegacyToken(
      await legacyJwt({ aud: `${RESOURCE_URI}/` }),
      env,
      RESOURCE_URI,
    )).resolves.toMatchObject({ audience: RESOURCE_URI });
  });

  it.each([
    ['missing audience', undefined],
    ['SSE audience', 'https://metro-mcp.anuragd.me/sse'],
    ['origin-only audience', 'https://metro-mcp.anuragd.me'],
    ['wrong origin', 'https://attacker.example/mcp'],
    ['broader path', 'https://metro-mcp.anuragd.me/'],
    ['query-bearing audience', `${RESOURCE_URI}?token=1`],
    ['fragment-bearing audience', `${RESOURCE_URI}#fragment`],
    ['multiple trailing slashes', `${RESOURCE_URI}//`],
    ['non-URL audience', 'metro-mcp'],
    ['array audience', [RESOURCE_URI]],
  ])('rejects %s', async (_label, aud) => {
    await expect(resolveLegacyToken(await legacyJwt({ aud }), env, RESOURCE_URI)).resolves.toBeNull();
  });

  it('rejects malformed compact tokens', async () => {
    await expect(resolveLegacyToken('not-a-jwt', env, RESOURCE_URI)).resolves.toBeNull();
    await expect(resolveLegacyToken('one.two.', env, RESOURCE_URI)).resolves.toBeNull();
  });

  it('rejects a token with a signature from another secret', async () => {
    const token = await legacyJwt({}, 'another-secret-that-is-at-least-32-bytes-long');
    await expect(resolveLegacyToken(token, env, RESOURCE_URI)).resolves.toBeNull();
  });

  it.each([
    ['missing algorithm', { typ: 'JWT' }],
    ['different algorithm', { alg: 'none', typ: 'JWT' }],
    ['non-object header', []],
  ])('rejects a HMAC-signed token with %s', async (_label, header) => {
    const token = await legacyJwt({}, SECRET, header);
    await expect(resolveLegacyToken(token, env, RESOURCE_URI)).resolves.toBeNull();
  });

  it.each([
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['blank subject', { sub: '   ' }],
    ['non-string subject', { sub: 42 }],
    ['missing login', { login: undefined }],
    ['empty login', { login: '' }],
    ['blank login', { login: '   ' }],
    ['non-string login', { login: 42 }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(resolveLegacyToken(await legacyJwt(overrides), env, RESOURCE_URI)).resolves.toBeNull();
  });

  it.each([
    ['missing expiration', { exp: undefined }],
    ['non-numeric expiration', { exp: '1786654800' }],
    ['expired expiration', { exp: Date.parse('2026-08-13T11:59:59Z') / 1_000 }],
    ['non-numeric not-before', { nbf: '1786654800' }],
    ['future not-before', { nbf: Date.parse('2026-08-13T12:00:01Z') / 1_000 }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(resolveLegacyToken(await legacyJwt(overrides), env, RESOURCE_URI)).resolves.toBeNull();
  });

  it('allows an embedded expiry after the cutoff only before the absolute cutoff', async () => {
    const token = await legacyJwt({
      exp: Math.floor(new Date('2026-12-01T00:00:00.000Z').getTime() / 1000),
    });

    await expect(resolveLegacyToken(token, env, RESOURCE_URI)).resolves.toMatchObject({
      audience: RESOURCE_URI,
    });
  });

  it('rejects at the exact absolute cutoff even when the embedded expiry is later', async () => {
    const token = await legacyJwt({
      exp: Math.floor(new Date('2026-12-01T00:00:00.000Z').getTime() / 1000),
    });
    vi.setSystemTime(new Date(CUTOFF));

    await expect(resolveLegacyToken(token, env, RESOURCE_URI)).resolves.toBeNull();
  });
});
