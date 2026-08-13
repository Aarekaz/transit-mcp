import type { ResolveExternalTokenResult } from '@cloudflare/workers-oauth-provider';

import type { Env } from '../types';

const LEGACY_JWT_CUTOFF_MS = Date.parse('2026-11-30T00:00:00Z');

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function parseJsonObject(encoded: string): Record<string, unknown> {
  const json = new TextDecoder().decode(decodeBase64Url(encoded));
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid legacy JWT object');
  }
  return value as Record<string, unknown>;
}

function canonicalizeAudience(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Validate a previously issued Metro JWT without issuing or refreshing it.
 * The caller passes a token already extracted from the Authorization header.
 */
export async function resolveLegacyToken(
  token: string,
  env: Env,
  resourceUri: string,
): Promise<ResolveExternalTokenResult | null> {
  try {
    if (Date.now() >= LEGACY_JWT_CUTOFF_MS) {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [header, payload, encodedSignature] = parts;
    if (!header || !payload || !encodedSignature) {
      return null;
    }

    const protectedHeader = parseJsonObject(header);
    if (protectedHeader.alg !== 'HS256'
      || (protectedHeader.typ !== undefined && protectedHeader.typ !== 'JWT')) {
      return null;
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const validSignature = await crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64Url(encodedSignature),
      encoder.encode(`${header}.${payload}`),
    );
    if (!validSignature) {
      return null;
    }

    const claims = parseJsonObject(payload);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || nowSeconds >= claims.exp) {
      return null;
    }
    if (claims.nbf !== undefined && (
      typeof claims.nbf !== 'number'
      || !Number.isFinite(claims.nbf)
      || claims.nbf > nowSeconds
    )) {
      return null;
    }
    if (typeof claims.sub !== 'string' || claims.sub.trim().length === 0) {
      return null;
    }
    if (typeof claims.login !== 'string' || claims.login.trim().length === 0) {
      return null;
    }
    if (canonicalizeAudience(claims.aud) !== resourceUri) {
      return null;
    }

    return {
      audience: resourceUri,
      props: {
        userId: claims.sub.trim(),
        userLogin: claims.login.trim(),
        clientId: 'legacy-jwt',
        scopes: ['transit:read'],
      },
    };
  } catch {
    return null;
  }
}
