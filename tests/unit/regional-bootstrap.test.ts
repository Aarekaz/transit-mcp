import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types';
import { bootstrapRegionalFeedHub } from '../../src/transit/gtfs/realtime/bootstrap';

describe('regional feed hub bootstrap', () => {
  it('instantiates the hub in dark/on modes without an upstream user request', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const env = {
      SFBAY_MODE: 'dark',
      REGION_FEED_HUB: { idFromName: () => ({}), get: () => ({ fetch }) },
    } as unknown as Env;
    await bootstrapRegionalFeedHub(env);
    expect(fetch).toHaveBeenCalledWith('https://region-feed-hub.internal/health');
  });

  it('does nothing when off, suspended, or unbound', async () => {
    const fetch = vi.fn();
    const namespace = { idFromName: () => ({}), get: () => ({ fetch }) };
    await bootstrapRegionalFeedHub({ SFBAY_MODE: 'off', REGION_FEED_HUB: namespace } as unknown as Env);
    await bootstrapRegionalFeedHub({ SFBAY_MODE: 'suspended', REGION_FEED_HUB: namespace } as unknown as Env);
    await bootstrapRegionalFeedHub({ SFBAY_MODE: 'dark' } as Env);
    expect(fetch).not.toHaveBeenCalled();
  });
});
