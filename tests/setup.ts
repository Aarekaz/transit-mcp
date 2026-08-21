/**
 * Test Setup and Utilities
 * 
 * WHY THIS FILE:
 * Provides reusable mocks and utilities for testing Cloudflare Workers code.
 * Makes tests more maintainable and consistent.
 * 
 * USAGE:
 * ```typescript
 * import { createMockEnv } from './setup';
 * 
 * const env = createMockEnv();
 * const result = await myFunction(env);
 * ```
 */

import { vi } from 'vitest';
import type { Env as WorkerEnv, TransitStation } from '../src/types';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

/**
 * Create a mock Env object for testing
 * 
 * WHY:
 * Tests need a consistent environment with all required variables.
 * This function provides sensible defaults that can be overridden.
 * 
 * USAGE:
 * ```typescript
 * const env = createMockEnv({ WMATA_API_KEY: 'test-key' });
 * ```
 */
export function createMockEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    MCP_PUBLIC_ORIGIN: 'https://metro-mcp.anuragd.me',
    MCP_ALLOWED_HOSTNAMES: 'metro-mcp.anuragd.me',
    MCP_ALLOWED_ORIGIN_HOSTNAMES: 'metro-mcp.anuragd.me',
    MCP_REQUEST_STATE_KEY: 'test-mrtr-request-state-key-32-bytes-minimum',
    WMATA_API_KEY: 'test-wmata-key',
    MCP_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) } as unknown as RateLimit,
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    ENVIRONMENT: 'production',
    ...overrides,
  };
}

/**
 * Create a mock Request object
 * 
 * WHY:
 * Workers Request objects have specific interfaces.
 * This helper creates properly-typed mock requests.
 * 
 * USAGE:
 * ```typescript
 * const request = createMockRequest('POST', '/api/endpoint', { key: 'value' });
 * ```
 */
export function createMockRequest(
  method: string = 'GET',
  url: string = 'http://localhost:8787/',
  body?: any,
  headers: Record<string, string> = {}
): Request {
  const init: RequestInit = {
    method,
    headers: new Headers(headers),
  };

  if (body) {
    init.body = JSON.stringify(body);
    if (!headers['Content-Type']) {
      (init.headers as Headers).set('Content-Type', 'application/json');
    }
  }

  return new Request(url, init);
}

/**
 * Create a mock Response object
 * 
 * WHY:
 * Simplifies creating responses for testing.
 */
export function createMockResponse(
  body: any,
  status: number = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    {
      status,
      headers: new Headers(headers),
    }
  );
}

/**
 * Mock fetch function
 * 
 * WHY:
 * Tests shouldn't make real HTTP requests.
 * This allows us to control what fetch returns.
 * 
 * USAGE:
 * ```typescript
 * const mockFetch = createMockFetch({ data: 'test' });
 * global.fetch = mockFetch;
 * ```
 */
export function createMockFetch(responseBody: any, status: number = 200) {
  return vi.fn().mockResolvedValue(
    createMockResponse(responseBody, status)
  );
}

/**
 * Test fixtures for transit stations
 */
export const mockDCStation: TransitStation = {
  id: 'A01',
  name: 'Metro Center',
  lines: ['RD', 'BL', 'OR', 'SV'],
  latitude: 38.898303,
  longitude: -77.028099,
  address: '607 13th St NW, Washington, DC 20005',
};

export const mockNYCStation: TransitStation = {
  id: '127',
  name: 'Times Square - 42nd St',
  lines: ['1', '2', '3', '7', 'N', 'Q', 'R', 'W', 'S'],
  latitude: 40.755983,
  longitude: -73.987495,
  address: 'Broadway & 42nd St, New York, NY 10036',
};

/**
 * Wait for async operations (useful in tests)
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Assert that a value is defined (TypeScript helper)
 */
export function assertDefined<T>(value: T | null | undefined): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error('Expected value to be defined');
  }
}
