import type { Env } from '../../../types';
import { SF511_QUOTA_NAMESPACE } from './snapshot-store';

export async function bootstrapRegionalFeedHub(env: Env): Promise<void> {
  if (!env.REGION_FEED_HUB || (env.SFBAY_MODE !== 'dark' && env.SFBAY_MODE !== 'on')) return;
  const id = env.REGION_FEED_HUB.idFromName(SF511_QUOTA_NAMESPACE);
  await env.REGION_FEED_HUB.get(id).fetch('https://region-feed-hub.internal/health');
}
