/**
 * Authentication Tests
 * 
 * WHY THESE TESTS:
 * Authentication is the foundation of security. These tests verify:
 * 1. JWT tokens are generated and verified correctly
 * 2. Token expiration works
 * 3. PKCE verification is secure
 * 4. OAuth flows handle errors properly
 * 
 * SECURITY CRITICAL:
 * These tests ensure that authentication can't be bypassed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthManager, AuthError } from '../../src/auth';
import { createMockEnv } from '../setup';
import type { Env } from '../../src/types';

describe('AuthManager', () => {
  let env: Env;
  let authManager: AuthManager;

  beforeEach(() => {
    env = createMockEnv();
    authManager = new AuthManager(env);
  });

  describe('generateAuthURL', () => {
    it('should generate valid GitHub OAuth URL', () => {
      const state = 'test-state-123';
      const url = authManager.generateAuthURL(state);

      expect(url).toContain('https://github.com/login/oauth/authorize');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('state=test-state-123');
      expect(url).toContain('response_type=code');
    });

    it('should throw if OAuth not configured', () => {
      const badEnv = createMockEnv({ GITHUB_CLIENT_ID: undefined as any });
      const manager = new AuthManager(badEnv);
      expect(() => manager.generateAuthURL('state')).toThrow(AuthError);
    });
  });

  describe('generateJWT', () => {
    it('should generate valid JWT token', async () => {
      const session = {
        userId: '12345',
        userLogin: 'testuser',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = await authManager.generateJWT(session);

      expect(token).toBeTruthy();
      expect(token.split('.')).toHaveLength(3);  // header.payload.signature
    });

    it('should include session data in JWT', async () => {
      const session = {
        userId: '12345',
        userLogin: 'testuser',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = await authManager.generateJWT(session);
      const [, payloadB64] = token.split('.');
      const payload = JSON.parse(atob(payloadB64!.replace(/-/g, '+').replace(/_/g, '/')));

      expect(payload.userId).toBe('12345');
      expect(payload.userLogin).toBe('testuser');
      expect(payload.exp).toBeTruthy();
      expect(payload.iat).toBeTruthy();
    });
  });

  describe('verifyJWT', () => {
    it('should verify valid JWT token', async () => {
      const session = {
        userId: '12345',
        userLogin: 'testuser',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = await authManager.generateJWT(session);
      const verified = await authManager.verifyJWT(token);

      expect(verified.userId).toBe('12345');
      expect(verified.userLogin).toBe('testuser');
    });

    it('should reject expired token', async () => {
      const session = {
        userId: '12345',
        userLogin: 'testuser',
        expiresAt: Math.floor(Date.now() / 1000) - 3600,  // Expired 1 hour ago
      };

      const token = await authManager.generateJWT(session);
      await expect(authManager.verifyJWT(token)).rejects.toThrow('Token expired');
    });

    it('should reject invalid token format', async () => {
      await expect(authManager.verifyJWT('invalid-token')).rejects.toThrow('Invalid token format');
    });

    it('should reject token with invalid signature', async () => {
      const session = {
        userId: '12345',
        userLogin: 'testuser',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = await authManager.generateJWT(session);
      const [header, payload] = token.split('.');
      const tamperedToken = `${header}.${payload}.invalidsignature`;

      await expect(authManager.verifyJWT(tamperedToken)).rejects.toThrow('Invalid token signature');
    });
  });

  describe('extractTokenFromRequest', () => {
    it('should extract Bearer token from Authorization header', () => {
      const request = new Request('http://localhost/', {
        headers: { 'Authorization': 'Bearer test-token-123' }
      });

      const token = authManager.extractTokenFromRequest(request);
      expect(token).toBe('test-token-123');
    });

    it('should return null if no Authorization header', () => {
      const request = new Request('http://localhost/');
      const token = authManager.extractTokenFromRequest(request);
      expect(token).toBeNull();
    });

    it('should return null if not Bearer token', () => {
      const request = new Request('http://localhost/', {
        headers: { 'Authorization': 'Basic dXNlcjpwYXNz' }
      });

      const token = authManager.extractTokenFromRequest(request);
      expect(token).toBeNull();
    });
  });

  describe('generateState', () => {
    it('should generate random state', () => {
      const state1 = authManager.generateState();
      const state2 = authManager.generateState();

      expect(state1).toBeTruthy();
      expect(state1).not.toBe(state2);  // Should be random
      expect(state1.length).toBe(64);   // 32 bytes = 64 hex chars
    });
  });

  describe('verifyPKCE', () => {
    it('should verify valid PKCE challenge', async () => {
      // Create a simple verifier and challenge
      const codeVerifier = 'test-verifier-123';
      
      // Calculate SHA-256 hash
      const encoder = new TextEncoder();
      const data = encoder.encode(codeVerifier);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = new Uint8Array(hashBuffer);
      const base64 = btoa(String.fromCharCode(...hashArray));
      const codeChallenge = base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const result = await authManager.verifyPKCE(codeVerifier, codeChallenge);
      expect(result).toBe(true);
    });

    it('should reject invalid PKCE challenge', async () => {
      const result = await authManager.verifyPKCE('verifier', 'wrong-challenge');
      expect(result).toBe(false);
    });
  });
});
