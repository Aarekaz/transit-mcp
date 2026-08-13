import {
  ProtocolError,
  type CacheHint,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { handleWMATAError } from '../error-handler';

export const citySchema = z.enum(['dc', 'nyc']);

export const coordinatesSchema = z.object({
  lat: z.number(),
  lon: z.number(),
});

export const addressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
}).nullable();

export const stationItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  lines: z.array(z.string()),
  coordinates: coordinatesSchema,
  address: addressSchema,
});

export const READ_ONLY_LIVE = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const satisfies ToolAnnotations;

export const PUBLIC_24H = {
  ttlMs: 24 * 60 * 60 * 1_000,
  cacheScope: 'public',
} as const satisfies CacheHint;

export const PRIVATE_NO_CACHE = {
  ttlMs: 0,
  cacheScope: 'private',
} as const satisfies CacheHint;

/** Build the matching text and structured forms required by MCP tool results. */
export function complete<Structured extends Record<string, unknown>>(structured: Structured) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/** Build a consistent, user-readable MCP tool error. */
export function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

/** Normalize upstream transit failures without destroying cancellation or protocol errors. */
export async function withTransitErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (ProtocolError.isInstance(error) || isAbortError(error)) {
      throw error;
    }
    throw new Error(handleWMATAError(error));
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError';
}
