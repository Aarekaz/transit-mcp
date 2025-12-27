/**
 * Rate Limiter Tests
 * 
 * WHY THESE TESTS:
 * Rate limiting is a critical security feature. These tests verify:
 * 1. Limits are enforced correctly
 * 2. Sliding window algorithm works
 * 3. KV operations are handled properly
 * 4. Error handling fails open (availability over strict limiting)
 * 5. Rate limit headers are correct
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RateLimiter,
  applyRateLimit,
  createRateLimitResponse,
} from '../../src/middleware/rate-limiter';
import { createMockEnv, createMockRequest } from '../setup';

describe('RateLimiter', () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    env = createMockEnv();
    // Reset time mocks
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkLimit', () => {
    it('should allow requests under the limit', async () => {
      const limiter = new RateLimiter(env, 'mcp');
      const result = await limiter.checkLimit('test-client');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);  // Started at 100, used 1
      expect(result.limit).toBe(100);
    });

    it('should block requests over the limit', async () => {
      const limiter = new RateLimiter(env, 'mcp');
      const clientId = 'test-client';

      // Make 100 requests (the limit)
      for (let i = 0; i < 100; i++) {
        await limiter.checkLimit(clientId);
      }

      // 101st request should be blocked
      const result = await limiter.checkLimit(clientId);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should reset after window expires', async () => {
      const limiter = new RateLimiter(env, 'mcp');
      const clientId = 'test-client';

      // Fill up the limit
      for (let i = 0; i < 100; i++) {
        await limiter.checkLimit(clientId);
      }

      // Should be blocked
      let result = await limiter.checkLimit(clientId);
      expect(result.allowed).toBe(false);

      // Advance time by 61 seconds (past the 60-second window)
      vi.advanceTimersByTime(61 * 1000);

      // Should be allowed again
      result = await limiter.checkLimit(clientId);
      expect(result.allowed).toBe(true);
    });

    it('should handle different clients independently', async () => {
      const limiter = new RateLimiter(env, 'mcp');

      // Client A makes 50 requests
      for (let i = 0; i < 50; i++) {
        await limiter.checkLimit('client-a');
      }

      // Client B makes 50 requests
      for (let i = 0; i < 50; i++) {
        await limiter.checkLimit('client-b');
      }

      // Both should still be allowed
      const resultA = await limiter.checkLimit('client-a');
      const resultB = await limiter.checkLimit('client-b');

      expect(resultA.allowed).toBe(true);
      expect(resultB.allowed).toBe(true);
    });

    it('should fail open on KV errors', async () => {
      // Create env with broken KV
      const brokenEnv = createMockEnv();
      if (brokenEnv.RATE_LIMIT_KV) {
        brokenEnv.RATE_LIMIT_KV.get = vi.fn().mockRejectedValue(new Error('KV error'));
      }

      const limiter = new RateLimiter(brokenEnv, 'mcp');
      const result = await limiter.checkLimit('test-client');

      // Should allow request even though KV failed
      expect(result.allowed).toBe(true);
    });

    it('should set correct expiration TTL', async () => {
      const limiter = new RateLimiter(env, 'mcp');
      const putSpy = vi.spyOn(env.RATE_LIMIT_KV!, 'put');

      await limiter.checkLimit('test-client');

      // Verify put was called with correct TTL (60s window + 60s buffer)
      expect(putSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        { expirationTtl: 120 }
      );
    });
  });

  describe('getClientId', () => {
    it('should extract CF-Connecting-IP', () => {
      const request = createMockRequest('GET', 'http://localhost/', undefined, {
        'CF-Connecting-IP': '192.168.1.1'
      });
      expect(RateLimiter.getClientId(request)).toBe('192.168.1.1');
    });

    it('should fallback to X-Real-IP', () => {
      const request = createMockRequest('GET', 'http://localhost/', undefined, {
        'X-Real-IP': '192.168.1.2'
      });
      expect(RateLimiter.getClientId(request)).toBe('192.168.1.2');
    });

    it('should fallback to X-Forwarded-For', () => {
      const request = createMockRequest('GET', 'http://localhost/', undefined, {
        'X-Forwarded-For': '192.168.1.3, 10.0.0.1'
      });
      expect(RateLimiter.getClientId(request)).toBe('192.168.1.3');
    });

    it('should return unknown if no IP headers', () => {
      const request = createMockRequest('GET', 'http://localhost/');
      expect(RateLimiter.getClientId(request)).toBe('unknown');
    });
  });

  describe('addRateLimitHeaders', () => {
    it('should add rate limit headers to response', () => {
      const response = new Response('test');
      const result = {
        allowed: true,
        remaining: 95,
        limit: 100,
        resetAt: 1704067260,
      };

      const newResponse = RateLimiter.addRateLimitHeaders(response, result);

      expect(newResponse.headers.get('X-RateLimit-Limit')).toBe('100');
      expect(newResponse.headers.get('X-RateLimit-Remaining')).toBe('95');
      expect(newResponse.headers.get('X-RateLimit-Reset')).toBe('1704067260');
    });

    it('should add Retry-After header when provided', () => {
      const response = new Response('test');
      const result = {
        allowed: false,
        remaining: 0,
        limit: 100,
        resetAt: 1704067260,
        retryAfter: 45,
      };

      const newResponse = RateLimiter.addRateLimitHeaders(response, result);

      expect(newResponse.headers.get('Retry-After')).toBe('45');
    });
  });

  describe('createRateLimitResponse', () => {
    it('should create JSON-RPC error response', () => {
      const result = {
        allowed: false,
        remaining: 0,
        limit: 100,
        resetAt: 1704067260,
        retryAfter: 45,
      };

      const response = createRateLimitResponse(result, true);

      expect(response.status).toBe(429);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Retry-After')).toBe('45');
    });

    it('should create plain text error response', () => {
      const result = {
        allowed: false,
        remaining: 0,
        limit: 100,
        resetAt: 1704067260,
        retryAfter: 45,
      };

      const response = createRateLimitResponse(result, false);

      expect(response.status).toBe(429);
      expect(response.headers.get('Content-Type')).toBe('text/plain');
    });
  });

  describe('applyRateLimit', () => {
    it('should apply rate limiting to a request', async () => {
      const request = createMockRequest('POST', 'http://localhost/sse', undefined, {
        'CF-Connecting-IP': '192.168.1.1'
      });

      const result = await applyRateLimit(request, env, 'mcp');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(100);
    });

    it('should use different configs for different endpoint types', async () => {
      const request = createMockRequest('GET', 'http://localhost/authorize');

      const mcpResult = await applyRateLimit(request, env, 'mcp');
      const oauthResult = await applyRateLimit(request, env, 'oauth');

      // OAuth should have higher limit
      expect(oauthResult.limit).toBeGreaterThan(mcpResult.limit);
    });
  });
});
