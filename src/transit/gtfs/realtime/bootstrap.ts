import type { Env } from '../../../types';

export async function bootstrapRegionalFeedHub(env: Env): Promise<void> {
  if (!env.REGION_FEED_HUB || (env.SFBAY_MODE !== 'dark' && env.SFBAY_MODE !== 'on')) return;
  const id = env.REGION_FEED_HUB.idFromName('sfbay');
  await env.REGION_FEED_HUB.get(id).fetch('https://region-feed-hub.internal/health');
}
