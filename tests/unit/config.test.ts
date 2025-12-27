/**
 * Configuration Tests
 * 
 * WHY THESE TESTS:
 * Configuration errors cause runtime failures. These tests ensure:
 * 1. Configuration loads correctly from environment
 * 2. Missing required variables are detected
 * 3. Validation catches invalid values
 * 4. Different endpoint types get correct rate limits
 */

import { describe, it, expect } from 'vitest';
import {
  loadConfig,
  getRateLimitConfig,
  validateConfig,
} from '../../src/config';
import { createMockEnv } from '../setup';

describe('Configuration', () => {
  describe('loadConfig', () => {
    it('should load configuration from valid environment', () => {
      const env = createMockEnv();
      const config = loadConfig(env);

      expect(config.oauth.github.clientId).toBe('test-client-id');
      expect(config.oauth.github.clientSecret).toBe('test-client-secret');
      expect(config.apis.wmata).toBe('test-wmata-key');
      expect(config.security.jwtSecret).toBeTruthy();
    });

    it('should throw on missing required variables', () => {
      const env = createMockEnv({ WMATA_API_KEY: undefined as any });
      expect(() => loadConfig(env)).toThrow('Missing required environment variables');
    });

    it('should set default values', () => {
      const env = createMockEnv();
      const config = loadConfig(env);

      expect(config.security.jwtExpirationSeconds).toBe(90 * 24 * 60 * 60);
      expect(config.rateLimit.enabled).toBe(true);
      expect(config.rateLimit.maxRequestsPerMinute).toBe(100);
    });

    it('should detect environment from redirect URI', () => {
      const devEnv = createMockEnv({
        OAUTH_REDIRECT_URI: 'http://localhost:8787/callback'
      });
      const config = loadConfig(devEnv);
      expect(config.app.environment).toBe('development');
    });

    it('should default to production environment', () => {
      const env = createMockEnv({
        OAUTH_REDIRECT_URI: 'https://metro-mcp.example.workers.dev/callback'
      });
      const config = loadConfig(env);
      expect(config.app.environment).toBe('production');
    });
  });

  describe('getRateLimitConfig', () => {
    it('should return base config for MCP endpoints', () => {
      const env = createMockEnv();
      const config = loadConfig(env);
      const rlConfig = getRateLimitConfig(config, 'mcp');

      expect(rlConfig.maxRequests).toBe(100);
      expect(rlConfig.windowSeconds).toBe(60);
    });

    it('should return higher limit for OAuth endpoints', () => {
      const env = createMockEnv();
      const config = loadConfig(env);
      const rlConfig = getRateLimitConfig(config, 'oauth');

      expect(rlConfig.maxRequests).toBe(200);  // 2x base
    });

    it('should return lower limit for static endpoints', () => {
      const env = createMockEnv();
      const config = loadConfig(env);
      const rlConfig = getRateLimitConfig(config, 'static');

      expect(rlConfig.maxRequests).toBe(50);  // 0.5x base
    });
  });

  describe('validateConfig', () => {
    it('should accept valid configuration', () => {
      const env = createMockEnv();
      const config = loadConfig(env);
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should reject invalid OAuth redirect URI', () => {
      const env = createMockEnv({
        OAUTH_REDIRECT_URI: 'not-a-valid-url'
      });
      const config = loadConfig(env);
      expect(() => validateConfig(config)).toThrow('Invalid OAuth redirect URI');
    });

    it('should reject short JWT secret', () => {
      const env = createMockEnv({
        JWT_SECRET: 'too-short'
      });
      const config = loadConfig(env);
      expect(() => validateConfig(config)).toThrow('JWT secret must be at least 32 characters');
    });

    it('should reject invalid rate limit values', () => {
      const env = createMockEnv();
      const config = loadConfig(env);
      config.rateLimit.maxRequestsPerMinute = 0;
      expect(() => validateConfig(config)).toThrow('maxRequestsPerMinute must be at least 1');
    });
  });
});
