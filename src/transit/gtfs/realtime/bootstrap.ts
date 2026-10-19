import type { Env } from '../../../types';
import { getCoverageMode } from '../../../regions/manifest';
import { getRealtimeSources } from './sources';

/** Cron keep-alive: wakes each dark or live coordinator so its alarm loop is scheduled. */
export async function bootstrapRegionalFeedHub(env: Env): Promise<void> {
  const hub = env.REGION_FEED_HUB;
  if (!hub) return;
  const active = getRealtimeSources().filter(source => ['dark', 'on'].includes(getCoverageMode(source.coverage.id, env)));
  const results = await Promise.allSettled(active.map(source =>
    hub.get(hub.idFromName(source.policy.namespace)).fetch('https://region-feed-hub.internal/health')));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw (failure as PromiseRejectedResult).reason;
}
