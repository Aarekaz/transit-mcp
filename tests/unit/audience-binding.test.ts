/**
 * RFC 8707 Resource Indicators — audience binding tests.
 *
 * Covers:
 *  - Tokens issued WITH `aud` are accepted only when the request matches.
 *  - Tokens issued WITH `aud` are REJECTED when the request canonical resource differs.
 *  - Tokens issued WITHOUT `aud` (legacy) are grandfathered.
 *  - Canonicalization rules (host casing, trailing slashes).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AuthManager } from '../../src/auth';
import { createMockEnv } from '../setup';
import type { AuthSession, Env } from '../../src/types';

describe('AuthManager — RFC 8707 audience binding', () => {
  let env: Env;
  let authManager: AuthManager;

  beforeEach(() => {
    env = createMockEnv();
    authManager = new AuthManager(env);
  });

  describe('canonicalizeResource', () => {
    it('lowercases the host', () => {
      expect(AuthManager.canonicalizeResource('https://Metro-MCP.example.com/mcp'))
        .toBe('https://metro-mcp.example.com/mcp');
    });

    it('strips trailing slashes', () => {
      expect(AuthManager.canonicalizeResource('https://example.com/mcp/'))
        .toBe('https://example.com/mcp');
      expect(AuthManager.canonicalizeResource('https://example.com/mcp///'))
        .toBe('https://example.com/mcp');
    });

    it('preserves root path as "/"', () => {
      expect(AuthManager.canonicalizeResource('https://example.com/'))
        .toBe('https://example.com/');
    });

    it('drops query and fragment', () => {
      expect(AuthManager.canonicalizeResource('https://example.com/mcp?x=1#y'))
        .toBe('https://example.com/mcp');
    });

    it('returns input unchanged for invalid URIs', () => {
      expect(AuthManager.canonicalizeResource('not a url'))
        .toBe('not a url');
    });
  });

  describe('expectedAudience', () => {
    it('derives canonical MCP resource from request URL', () => {
      expect(AuthManager.expectedAudience('https://metro-mcp.example.com/mcp'))
        .toBe('https://metro-mcp.example.com/mcp');
    });

    it('normalizes regardless of the actual path hit', () => {
      // Different paths all collapse to the canonical resource at /mcp
      expect(AuthManager.expectedAudience('https://metro-mcp.example.com/sse'))
        .toBe('https://metro-mcp.example.com/mcp');
      expect(AuthManager.expectedAudience('https://metro-mcp.example.com/'))
        .toBe('https://metro-mcp.example.com/mcp');
    });

    it('lowercases the host', () => {
      expect(AuthManager.expectedAudience('https://METRO-MCP.example.com/mcp'))
        .toBe('https://metro-mcp.example.com/mcp');
    });
  });

  describe('verifyAudience', () => {
    const baseSession = (audience?: string): AuthSession => ({
      userId: '12345',
      userLogin: 'testuser',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      audience
    });

    it('accepts a token whose aud matches the request resource', () => {
      const session = baseSession('https://metro-mcp.example.com/mcp');
      expect(authManager.verifyAudience(session, 'https://metro-mcp.example.com/mcp')).toBe(true);
    });

    it('accepts when the only difference is host casing', () => {
      const session = baseSession('https://Metro-MCP.example.com/mcp');
      expect(authManager.verifyAudience(session, 'https://metro-mcp.example.com/mcp')).toBe(true);
    });

    it('accepts when the only difference is a trailing slash', () => {
      const session = baseSession('https://metro-mcp.example.com/mcp/');
      expect(authManager.verifyAudience(session, 'https://metro-mcp.example.com/mcp')).toBe(true);
    });

    it('REJECTS when the aud points to a different host', () => {
      const session = baseSession('https://other.example.com/mcp');
      expect(authManager.verifyAudience(session, 'https://metro-mcp.example.com/mcp')).toBe(false);
    });

    it('REJECTS when the aud points to a different scheme', () => {
      const session = baseSession('http://metro-mcp.example.com/mcp');
      expect(authManager.verifyAudience(session, 'https://metro-mcp.example.com/mcp')).toBe(false);
    });

    it('grandfathers legacy tokens with no aud claim', () => {
      const session = baseSession(undefined);
      expect(authManager.verifyAudience(session, 'https://metro-mcp.example.com/mcp')).toBe(true);
    });
  });

  describe('JWT round trip', () => {
    it('persists audience through generateJWT → verifyJWT', async () => {
      const aud = 'https://metro-mcp.example.com/mcp';
      const session: AuthSession = {
        userId: '12345',
        userLogin: 'testuser',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        audience: aud
      };

      const token = await authManager.generateJWT(session);
      const decoded = await authManager.verifyJWT(token);

      expect(decoded.audience).toBe(aud);
    });

    it('omits aud claim when session has no audience (legacy issuance)', async () => {
      const session: AuthSession = {
        userId: '12345',
        userLogin: 'testuser',
        expiresAt: Math.floor(Date.now() / 1000) + 3600
      };

      const token = await authManager.generateJWT(session);
      const decoded = await authManager.verifyJWT(token);

      expect(decoded.audience).toBeUndefined();
    });
  });
});
