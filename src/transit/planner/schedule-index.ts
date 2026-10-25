import { parseTransitRef, type TransitRef } from '../core/refs';
import { count, phase } from '../trace';
import type { VerificationReason } from '../core/results';
import type { ArtifactManifestV2, ScheduleShard, SourceMetadata } from '../gtfs/static/schema';
import { canonicalJson, decodeScheduleShard, sha256 } from '../gtfs/static/shards';
import { parseServiceDate } from '../gtfs/static/time';
import { formatInstant, MAX_STOP_TIME_SECONDS, parseInstant, serviceDateAtInstant, serviceDayOrigin, shiftServiceDate } from './service-day';

export interface ScheduleWindowQuery {
  manifest: ArtifactManifestV2;
  /** Reads one immutable object. Implementations must also cap transport size. */
  readShard: (key: string) => Promise<Uint8Array>;
  /** Decoded shards kept across calls by a long-lived reader (the realtime coordinator). */
  decoded?: DecodedShardCache;
  /** Whole decodes kept across requests (the isolate's), consulted after `decoded`. */
  resident?: DecodedShardCache;
  instant: string;
  /** Half-open interval [instant, instant + windowSeconds), maximum seven days. */
  windowSeconds: number;
  feedIds?: string[];
  agencyRefs?: TransitRef[];
  /** Fetch this many shards' bytes at once (decoding stays sequential). For a reader whose
   * window is many small objects, such as one agency group's hourly bands. Default 1. */
  readConcurrency?: number;
  /** Decode only these routes' trips (see decodeScheduleShard): for a search along them. */
  decodeRoutes?: ReadonlySet<TransitRef>;
  /** A whole decode already resident may serve `decodeRoutes`, for a caller that picks its
   * trips itself (a departure board): an extra route costs nothing there, a read and decode do. */
  wholeServesRoutes?: boolean;
}
export interface ScheduleDay {
  agencyRef: TransitRef; timezone: string; serviceDate: string; startTime: string;
}
export interface LoadedScheduleShard { shard: ScheduleShard; key: string; serviceDays: ScheduleDay[] }
export interface ScheduleWindow {
  status: 'scheduled_only' | 'unavailable'; reasons: VerificationReason[];
  startTime: string; endTime: string; sources: SourceMetadata[];
  shards: LoadedScheduleShard[];
}
type Descriptor = ArtifactManifestV2['shards'][number];
const BYTE_BUDGET = 64 * 1024 * 1024;

function covers(descriptor: Descriptor, date: string): boolean {
  return date >= descriptor.window.startDate && date <= descriptor.window.endDate;
}
function sameWindow(left: Descriptor, right: Descriptor): boolean {
  return left.window.startDate === right.window.startDate && left.window.endDate === right.window.endDate;
}
function withinFeed(source: SourceMetadata, date: string): boolean {
  return source.feedInfo.every(info => (!info.feed_start_date || date >= info.feed_start_date) && (!info.feed_end_date || date <= info.feed_end_date));
}

/** Pure selection plus an injected immutable-byte reader; no R2 or global clock dependency. */
/** Verified, decoded shards by content hash, least recently used first out. Objects are
 * immutable: shards are content-addressed and never edited after decoding. */
export class DecodedShardCache {
  readonly #entries = new Map<string, { shard: ScheduleShard; bytes: number }>();
  #bytes = 0;
  constructor(private readonly maxFileBytes: number) {}
  /** `variant` names a route-filtered decode of the same object. */
  get(descriptor: { sha256: string; byteLength: number }, variant = ''): ScheduleShard | undefined {
    const key = `${descriptor.sha256}/${descriptor.byteLength}${variant}`, entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key); this.#entries.set(key, entry);
    return entry.shard;
  }
  *shards(): Iterable<ScheduleShard> { for (const entry of this.#entries.values()) yield entry.shard; }
  clear(): void { this.#entries.clear(); this.#bytes = 0; }
  set(descriptor: { sha256: string; byteLength: number }, shard: ScheduleShard, variant = ''): void {
    if (descriptor.byteLength > this.maxFileBytes) return;
    const key = `${descriptor.sha256}/${descriptor.byteLength}${variant}`;
    if (this.#entries.has(key)) return;
    this.#entries.set(key, { shard, bytes: descriptor.byteLength }); this.#bytes += descriptor.byteLength;
    for (const [old, entry] of this.#entries) {
      if (this.#bytes <= this.maxFileBytes) break;
      this.#entries.delete(old); this.#bytes -= entry.bytes;
    }
  }
}

export async function loadScheduleWindow(query: ScheduleWindowQuery): Promise<ScheduleWindow> {
  return phase('schedule', () => loadScheduleWindowUntraced(query));
}
export interface SelectedShard { descriptor: Descriptor; days: ScheduleDay[]; source: SourceMetadata }
/** Which shards, for which service days, a window needs: pure, reads nothing. The compact
 * network search selects exactly what the exact loader would. */
export function selectScheduleWindow(query: Omit<ScheduleWindowQuery, 'readShard' | 'decoded' | 'readConcurrency'>): { window: ScheduleWindow; selected: SelectedShard[] } {
  const start = parseInstant(query.instant), end = start + query.windowSeconds * 1000;
  if (!Number.isInteger(query.windowSeconds) || query.windowSeconds <= 0 || query.windowSeconds > 7 * 86400) throw new Error('TIME_OUTSIDE_WINDOW: search window must be between 1 second and 7 days');
  const { manifest } = query;
  if (manifest.schemaVersion !== 2) throw new Error('Invalid schedule manifest');
  const result: ScheduleWindow = { status: 'scheduled_only', reasons: [], startTime: formatInstant(start, 'UTC'),
    endTime: formatInstant(end, 'UTC'), sources: [], shards: [] };
  const unavailable = (reason: VerificationReason) => ({ window: { ...result, status: 'unavailable' as const, reasons: [reason], shards: [] }, selected: [] });
  const feeds = [...new Set(query.feedIds ?? manifest.sources.map(source => source.feedId))].sort();
  if (!feeds.length) return unavailable('COVERAGE_UNAVAILABLE');
  const selected = new Map<string, SelectedShard>();
  for (const feed of feeds) {
    const sources = manifest.sources.filter(source => source.feedId === feed);
    if (!sources.length) return unavailable('COVERAGE_UNAVAILABLE');
    if (sources.length !== 1) throw new Error('Ambiguous schedule source identity');
    const source = sources[0]!;
    result.sources.push(source);
    for (const info of source.feedInfo) {
      if (info.feed_start_date) parseServiceDate(info.feed_start_date);
      if (info.feed_end_date) parseServiceDate(info.feed_end_date);
    }
    const descriptors = manifest.shards.filter(shard => shard.feedId === feed).sort((a, b) => a.byteLength - b.byteLength || a.key.localeCompare(b.key));
    if (!descriptors.length) return unavailable('SCHEDULE_EXPIRED');
    for (const descriptor of descriptors) {
      if (!Number.isInteger(descriptor.maxStopTimeSeconds) || descriptor.maxStopTimeSeconds < 0 || descriptor.maxStopTimeSeconds > MAX_STOP_TIME_SECONDS) throw new Error('Invalid timetable bound');
      if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 16) throw new Error('Invalid shard byte budget');
      if (parseServiceDate(descriptor.window.startDate) > parseServiceDate(descriptor.window.endDate)) throw new Error('Invalid shard service window');
      const range = descriptor.timeRange;
      if (range && (descriptor.window.startDate !== descriptor.window.endDate || ![range.bandStart, range.bandEnd, range.start, range.end].every(Number.isSafeInteger) ||
        range.bandStart >= range.bandEnd || range.start > range.end || range.end > descriptor.maxStopTimeSeconds && range.end !== range.bandStart)) throw new Error('Invalid shard time band');
    }
    // Every window carries the same feed-wide bound, including excluded trips.
    const maximum = descriptors[0]!.maxStopTimeSeconds;
    if (descriptors.some(descriptor => descriptor.maxStopTimeSeconds !== maximum)) throw new Error('Inconsistent schedule identity');
    const agencies = Object.entries(manifest.agencyTimezones).filter(([ref]) => {
      const parsed = parseTransitRef(ref);
      return parsed?.kind === 'agency' && parsed.coverage === manifest.coverageId && parsed.feed === feed &&
        (!query.agencyRefs || query.agencyRefs.includes(ref as TransitRef));
    });
    if (!agencies.length && !query.agencyRefs) return unavailable('COVERAGE_UNAVAILABLE');
    for (const [agencyRef, timezone] of agencies) {
      const firstCivil = serviceDateAtInstant(start, timezone), lastCivil = serviceDateAtInstant(end - 1, timezone);
      const first = shiftServiceDate(firstCivil, -Math.ceil(maximum / 86400) - 1);
      const last = shiftServiceDate(lastCivil, 1);
      for (let date = first; date <= last; date = shiftServiceDate(date, 1)) {
        const origin = serviceDayOrigin(date, timezone);
        const requested = date >= firstCivil && date <= lastCivil;
        const contributes = origin < end && origin + maximum * 1000 >= start;
        if (!requested && !contributes) continue;
        if (!withinFeed(source, date)) {
          if (requested) return unavailable('SCHEDULE_EXPIRED');
          continue;
        }
        const chosen = [...selected.values()].find(item => item.descriptor.feedId === feed && covers(item.descriptor, date))?.descriptor
          ?? descriptors.find(descriptor => covers(descriptor, date));
        if (!chosen) return unavailable('SCHEDULE_EXPIRED');
        // Time bands of one window together are that date's timetable; load only the
        // bands whose calls can fall inside the query.
        const group = chosen.timeRange ? descriptors.filter(descriptor => descriptor.timeRange && sameWindow(descriptor, chosen)) : [chosen];
        for (const descriptor of group) {
          if (descriptor.timeRange && !(origin + descriptor.timeRange.start * 1000 < end && origin + descriptor.timeRange.end * 1000 >= start)) continue;
          // An agency-split band serves only the agencies it names.
          if (descriptor.agencyRefs && !descriptor.agencyRefs.includes(agencyRef as TransitRef)) continue;
          let entry = selected.get(descriptor.key);
          if (!entry) { entry = { descriptor, days: [], source }; selected.set(descriptor.key, entry); }
          entry.days.push({ agencyRef: agencyRef as TransitRef, timezone, serviceDate: date, startTime: formatInstant(origin, timezone) });
        }
      }
    }
  }
  return { window: result, selected: [...selected.values()] };
}
async function loadScheduleWindowUntraced(query: ScheduleWindowQuery): Promise<ScheduleWindow> {
  const { window: result, selected: entries } = selectScheduleWindow(query);
  if (result.status === 'unavailable') return result;
  const { manifest } = query;
  const variant = query.decodeRoutes ? `/${[...query.decodeRoutes].sort().join(',')}` : '';
  const bytesRequired = entries.reduce((sum, item) => sum + item.descriptor.byteLength, 0);
  if (bytesRequired > BYTE_BUDGET) throw new Error('Schedule shard byte budget exceeded');
  // Sequential decoding bounds the transient byte buffers and pins one source per feed.
  // With readConcurrency, up to that many reads are in flight ahead of the decoder.
  const concurrency = Math.max(1, Math.min(16, query.readConcurrency ?? 1));
  const pending = new Map<number, Promise<Uint8Array>>();
  const prefetch = (from: number) => { for (let at = from; at < Math.min(entries.length, from + concurrency); at++) if (!pending.has(at) && !query.decoded?.get(entries[at]!.descriptor, variant) && !((!variant || query.wholeServesRoutes) && query.resident?.get(entries[at]!.descriptor))) { const read = query.readShard(entries[at]!.descriptor.key); read.catch(() => {}); pending.set(at, read); } };
  for (const [position, { descriptor, days, source }] of entries.entries()) {
    let shard = query.decoded?.get(descriptor, variant) ?? (variant && !query.wholeServesRoutes ? undefined : query.resident?.get(descriptor));
    if (shard) query.decoded?.set(descriptor, shard, variant);
    else {
      if (concurrency > 1) prefetch(position);
      const bytes = await (pending.get(position) ?? query.readShard(descriptor.key));
      pending.delete(position);
      if (bytes.byteLength !== descriptor.byteLength || await sha256(bytes) !== descriptor.sha256) throw new Error('Schedule shard integrity failure');
      shard = decodeScheduleShard(bytes, query.decodeRoutes);
      count('shardsDecoded'); count('shardBytes', bytes.byteLength);
      query.decoded?.set(descriptor, shard, variant);
      if (!variant) query.resident?.set(descriptor, shard);
    }
    const agencyTimezones = Object.fromEntries(Object.entries(manifest.agencyTimezones).filter(([ref]) => parseTransitRef(ref)?.feed === descriptor.feedId));
    if (shard.coverageId !== manifest.coverageId || shard.feedId !== descriptor.feedId || shard.source.sha256 !== source.sha256 ||
      canonicalJson(shard.source) !== canonicalJson(source) || canonicalJson(shard.agencyTimezones) !== canonicalJson(agencyTimezones) ||
      shard.maxStopTimeSeconds !== descriptor.maxStopTimeSeconds || shard.window.startDate !== descriptor.window.startDate || shard.window.endDate !== descriptor.window.endDate ||
      canonicalJson(shard.timeRange ?? null) !== canonicalJson(descriptor.timeRange ?? null) ||
      days.some(day => shard.agencyTimezones[day.agencyRef] !== day.timezone) ||
      descriptor.agencyRefs && shard.routes.some(route => !descriptor.agencyRefs!.includes(route.agencyRef))) throw new Error('Schedule shard identity mismatch');
    result.shards.push({ shard, key: descriptor.key, serviceDays: days });
  }
  return result;
}
