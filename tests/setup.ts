/**
 * Test Setup and Utilities
 * 
 * WHY THIS FILE:
 * Provides reusable mocks and utilities for testing Cloudflare Workers code.
 * Makes tests more maintainable and consistent.
 * 
 * USAGE:
 * ```typescript
 * import { createMockEnv, createMockKV } from './setup';
 * 
 * const env = createMockEnv();
 * const result = await myFunction(env);
 * ```
 */

import { vi } from 'vitest';
import type { Env, OAuthClient, TransitStation } from '../src/types';

/**
 * Mock KVNamespace implementation
 * 
 * WHY NEEDED:
 * KVNamespace is a Cloudflare Workers API not available in test environment.
 * We need to mock it to test code that uses KV.
 * 
 * IMPLEMENTATION:
 * Uses an in-memory Map for storage, implements KV interface.
 */
export function createMockKV(): KVNamespace {
  const storage = new Map<string, { value: string; expiration?: number }>();

  return {
    async get(key: string): Promise<string | null> {
      const item = storage.get(key);
      if (!item) return null;
      
      // Check expiration
      if (item.expiration && Date.now() > item.expiration) {
        storage.delete(key);
        return null;
      }
      
      return item.value;
    },

    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const expiration = options?.expirationTtl 
        ? Date.now() + (options.expirationTtl * 1000)
        : undefined;
      
      storage.set(key, { value, expiration });
    },

    async delete(key: string): Promise<void> {
      storage.delete(key);
    },

    async list(): Promise<any> {
      return {
        keys: Array.from(storage.keys()).map(name => ({ name })),
        list_complete: true,
        cursor: '',
      };
    },

    // Additional methods for testing
    getWithMetadata: vi.fn(),
    getMultiple: vi.fn(),
    setMultiple: vi.fn(),
  } as any;
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
export function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    OAUTH_REDIRECT_URI: 'http://localhost:8787/callback',
    WMATA_API_KEY: 'test-wmata-key',
    JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
    OAUTH_CLIENTS: createMockKV(),
    RATE_LIMIT_KV: createMockKV(),
    ENVIRONMENT: 'test',
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
 * Test fixtures for OAuth clients
 */
export const mockOAuthClient: OAuthClient = {
  client_id: 'test-client-123',
  client_secret: 'hashed-secret',
  redirect_uris: ['http://localhost:3000/callback'],
  client_name: 'Test Client',
  created_at: Date.now(),
};

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
