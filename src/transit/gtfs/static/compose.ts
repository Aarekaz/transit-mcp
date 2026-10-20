import { parseTransitRef } from '../../core/refs';
import type { ArtifactManifestV2, ValidatorEvidence } from './schema';

const byFeed = <T extends { feedId: string }>(items: T[]) => [...items].sort((a, b) => a.feedId < b.feedId ? -1 : a.feedId > b.feedId ? 1 : 0);

/** Every feed's validator evidence, keyed by feed. A single-feed manifest keeps its one
 * `validator`; composing more feeds moves evidence to `validators`. */
function evidence(manifest: ArtifactManifestV2): Record<string, ValidatorEvidence> {
  if (manifest.validators) return { ...manifest.validators };
  return manifest.validator && manifest.sources.length === 1 ? { [manifest.sources[0]!.feedId]: manifest.validator } : {};
}

/** A coverage publishes one manifest for all its feeds (subway, commuter rail, buses), so a
 * journey can use any of them. Replaces one feed's sources, discovery and shards in `base`
 * with those of `feed` (a manifest built from that feed alone) and leaves every other feed
 * exactly as published. Without a base, the feed's manifest is the coverage's. */
export function composeManifest(base: ArtifactManifestV2 | null, feed: ArtifactManifestV2): ArtifactManifestV2 {
  const feedIds = new Set(feed.sources.map(source => source.feedId));
  if (feedIds.size !== 1 || feed.discoveries.some(item => !feedIds.has(item.feedId)) || feed.shards.some(item => !feedIds.has(item.feedId))) {
    throw new Error('A feed manifest must describe exactly one feed');
  }
  if (!base) return feed;
  if (base.coverageId !== feed.coverageId || base.schemaVersion !== feed.schemaVersion) throw new Error('Manifest coverage mismatch');
  const [feedId] = feedIds as unknown as [string];
  const keep = <T extends { feedId: string }>(items: T[]) => items.filter(item => item.feedId !== feedId);
  const agencyTimezones = Object.fromEntries(Object.entries(base.agencyTimezones).filter(([ref]) => parseTransitRef(ref)?.feed !== feedId));
  for (const [ref, timezone] of Object.entries(feed.agencyTimezones)) {
    if (agencyTimezones[ref] !== undefined && agencyTimezones[ref] !== timezone) throw new Error('Conflicting agency timezone');
    agencyTimezones[ref] = timezone;
  }
  const sources = byFeed([...keep(base.sources), ...feed.sources]);
  const validators = { ...evidence(base), ...evidence(feed) };
  if (!evidence(feed)[feedId]) delete validators[feedId];
  const { validator: _single, validators: _many, ...rest } = base;
  return { ...rest, sources, agencyTimezones,
    discoveries: byFeed([...keep(base.discoveries), ...feed.discoveries]),
    shards: byFeed([...keep(base.shards), ...feed.shards]),
    ...(sources.length === 1 ? (validators[sources[0]!.feedId] ? { validator: validators[sources[0]!.feedId] } : {}) : Object.keys(validators).length ? { validators } : {}) };
}
