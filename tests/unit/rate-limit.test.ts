import { describe, expect, it, vi } from 'vitest';

import {
  MCP_RATE_LIMIT,
  MCP_RATE_LIMIT_PERIOD_SECONDS,
  anonymousMcpRateLimitResponse,
} from '../../src/rate-limit';

function request(headers: HeadersInit = {}): Request {
  return new Request('https://metro-mcp.anuragd.me/mcp', {
    method: 'POST',
    headers,
  });
}

describe('anonymousMcpRateLimitResponse', () => {
  it('accepts a Cloudflare-identified client using only CF-Connecting-IP', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const limiter = { limit } as unknown as RateLimit;

    await expect(anonymousMcpRateLimitResponse(request({
      'CF-Connecting-IP': '198.51.100.10',
      'X-Forwarded-For': '203.0.113.99',
      Authorization: 'Bearer ignored',
      'Mcp-Name': 'ignored-tool-name',
    }), limiter)).resolves.toBeUndefined();

    expect(limit).toHaveBeenCalledWith({ key: '198.51.100.10' });
  });

  it('uses the deterministic local fallback when Cloudflare does not provide an IP', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });

    await expect(anonymousMcpRateLimitResponse(request({
      'X-Forwarded-For': '203.0.113.99',
    }), { limit } as unknown as RateLimit)).resolves.toBeUndefined();

    expect(limit).toHaveBeenCalledWith({ key: 'local' });
  });

  it('returns the exact JSON-RPC response when quota is denied without exposing the client IP', async () => {
    const response = await anonymousMcpRateLimitResponse(request({
      'CF-Connecting-IP': '198.51.100.10',
    }), {
      limit: vi.fn().mockResolvedValue({ success: false }),
    } as unknown as RateLimit);

    expect(response).toBeDefined();
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
    expect(await response?.clone().json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Rate limit exceeded' },
      id: null,
    });
    expect(await response?.text()).not.toContain('198.51.100.10');
  });

  it('propagates a limiter binding failure for the worker error boundary to fail closed', async () => {
    const failure = new Error('binding unavailable');

    await expect(anonymousMcpRateLimitResponse(request(), {
      limit: vi.fn().mockRejectedValue(failure),
    } as unknown as RateLimit)).rejects.toBe(failure);
  });

  it('uses the configured initial Cloudflare policy values', () => {
    expect(MCP_RATE_LIMIT).toBe(300);
    expect(MCP_RATE_LIMIT_PERIOD_SECONDS).toBe(60);
  });
});
