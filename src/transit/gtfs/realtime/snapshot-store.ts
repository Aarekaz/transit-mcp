import type { RealtimeFeedKind } from '../../../regions/types';
import { count, phase } from '../../trace';
import type { ArtifactManifestV2 } from '../static/schema';
import { canonicalJson, sha256 } from '../static/shards';

export interface StaticVersion { artifactVersion: string; sourceVersions: Record<string, string> }
export interface NormalizedRealtimeSnapshot<T = unknown> {
  version: StaticVersion; producerTimestampSeconds?: number; receivedAtSeconds: number;
  payload: T[] | null; warnings?: string[]; degraded?: boolean;
  /** Tag of the complete payload, new with every publish; absent for filtered reads. */
  etag?: string;
}
const encode = (value: unknown) => new TextEncoder().encode(`${canonicalJson(value)}\n`);
/** Bound on a snapshot's freshness metadata (warnings included). */
const METADATA_BYTES = 120 * 1024;
export const SF511_QUOTA_NAMESPACE = 'sfbay:511';

/** Versions of resident manifests, which are never edited in place: hashing a large
 * manifest (SF Bay's lists every band) costs more than a whole small plan. */
const versions = new WeakMap<ArtifactManifestV2, { shards: unknown; sources: unknown; version: Promise<StaticVersion> }>();
export async function staticVersion(manifest: ArtifactManifestV2): Promise<StaticVersion> {
  const held = versions.get(manifest);
  if (held && held.shards === manifest.shards && held.sources === manifest.sources) return held.version;
  const version = computeStaticVersion(manifest);
  versions.set(manifest, { shards: manifest.shards, sources: manifest.sources, version });
  version.catch(() => versions.delete(manifest));
  return version;
}
async function computeStaticVersion(manifest: ArtifactManifestV2): Promise<StaticVersion> {
  if (manifest.schemaVersion !== 2 || typeof manifest.coverageId !== 'string' || !/^[a-z0-9_]+$/.test(manifest.coverageId) || !manifest.sources.length ||
      new Set(manifest.sources.map(s => s.feedId)).size !== manifest.sources.length ||
      manifest.sources.some(s => !/^[a-f0-9]{64}$/.test(s.sha256))) throw new Error('Invalid static source identity');
  return { artifactVersion: await sha256(encode(manifest)), sourceVersions: Object.fromEntries(manifest.sources.map(s => [s.feedId, s.sha256])) };
}

/** How far ahead of a reader's clock a provider timestamp still counts. Realtime fetched
 * while the request waited (a cold coordinator's first poll) is newer than the request, and
 * provider clocks drift; past this a timestamp is bogus. */
export const CLOCK_TOLERANCE_SECONDS = 120;
/** The clock to judge `stamp` by: the reader's, unless the stamp is plausibly just ahead of
 * it, in which case the data is brand new (age zero), not invalid. */
export function judgedAt(now: number, stamp: number | undefined): number {
  return stamp !== undefined && stamp > now && stamp <= now + CLOCK_TOLERANCE_SECONDS ? stamp : now;
}

export function sameStaticVersion(left: StaticVersion, right: StaticVersion): boolean {
  return left.artifactVersion === right.artifactVersion && canonicalJson(left.sourceVersions) === canonicalJson(right.sourceVersions);
}

export async function readBoundedObject(bucket: R2Bucket, key: string, maximum: number): Promise<Uint8Array> {
  return phase('r2', async () => {
    const bytes = await readBounded(bucket, key, maximum);
    count('r2Reads'); count('r2Bytes', bytes.byteLength);
    return bytes;
  });
}
async function readBounded(bucket: R2Bucket, key: string, maximum: number): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) throw new Error('Artifact object is unavailable');
  if (object.size > maximum) throw new Error('Artifact object byte budget exceeded');
  // Streaming cap also applies when a transport supplies an incorrect size.
  const reader = object.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error('Artifact object byte budget exceeded'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** The cache owns only one manifest. Timetable shards are scoped to each query.
 * Old immutable manifests remain in R2 and are never loaded just to match stale RT. */
export class StaticArtifactStore {
  #resident?: { version: StaticVersion; manifest: ArtifactManifestV2 };
  private readonly manifestPrefix: string;
  private readonly pointerKey: string;
  constructor(private readonly bucket: R2Bucket, private readonly coverageId = 'sfbay') {
    if (!/^[a-z0-9_]+$/.test(coverageId)) throw new Error('Invalid coverage namespace');
    this.manifestPrefix = `artifacts/${coverageId}/v2/manifests/`;
    this.pointerKey = `artifacts/${coverageId}/v2/current.json`;
  }
  get residentVersion(): string | undefined { return this.#resident?.version.artifactVersion; }

  async publish(manifest: ArtifactManifestV2): Promise<StaticVersion> {
    if (manifest.coverageId !== this.coverageId) throw new Error('Static manifest coverage mismatch');
    const version = await staticVersion(manifest);
    if (encode(manifest).length > 2 * 1024 * 1024) throw new Error('Static manifest metadata budget exceeded');
    const pointer = await this.bucket.get(this.pointerKey);
    const prior = pointer ? JSON.parse(await pointer.text()) as { current: string; previous?: string } : undefined;
    await this.bucket.put(`${this.manifestPrefix}${version.artifactVersion}.json`, encode(manifest));
    await this.bucket.put(this.pointerKey, encode({ current: version.artifactVersion, previous: prior?.current === version.artifactVersion ? prior.previous : prior?.current }));
    this.#resident = { version, manifest };
    return version;
  }

  /** Returns the pointer to the previous version if the current one is still `expected`. */
  async rollback(expected: string): Promise<boolean> {
    const pointer = await this.bucket.get(this.pointerKey);
    if (!pointer) return false;
    const value = JSON.parse(await pointer.text()) as { current: string; previous?: string };
    if (value.current !== expected || !value.previous) return false;
    await this.read(value.previous); // Never point at an unreadable manifest.
    await this.bucket.put(this.pointerKey, encode({ current: value.previous, previous: value.current }));
    this.#resident = undefined;
    return true;
  }

  async pointer(): Promise<{ current: string; previous?: string } | null> {
    const pointer = await this.bucket.get(this.pointerKey);
    return pointer ? JSON.parse(await pointer.text()) as { current: string; previous?: string } : null;
  }

  async current(): Promise<{ version: StaticVersion; manifest: ArtifactManifestV2 } | null> {
    const pointer = await this.bucket.get(this.pointerKey);
    if (!pointer) return null;
    if (pointer.size > 1024) throw new Error('Invalid static pointer');
    const value = JSON.parse(await pointer.text()) as { current: string };
    return this.read(value.current);
  }

  async read(artifactVersion: string): Promise<{ version: StaticVersion; manifest: ArtifactManifestV2 }> {
    if (!/^[a-f0-9]{64}$/.test(artifactVersion)) throw new Error('Invalid artifact version');
    if (this.#resident?.version.artifactVersion === artifactVersion) return this.#resident;
    this.#resident = undefined; // Release old identity before reading the replacement.
    const bytes = await readBoundedObject(this.bucket, `${this.manifestPrefix}${artifactVersion}.json`, 2 * 1024 * 1024);
    if (await sha256(bytes) !== artifactVersion) throw new Error('Static manifest integrity failure');
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as ArtifactManifestV2;
    if (manifest.coverageId !== this.coverageId) throw new Error('Static manifest coverage mismatch');
    const version = await staticVersion(manifest);
    if (version.artifactVersion !== artifactVersion) throw new Error('Static manifest identity mismatch');
    return this.#resident = { version, manifest };
  }
}

function indexKey(value: unknown): string {
  const record = value as { stopId?: string; entityId?: string; id?: string };
  return record.stopId ?? record.entityId ?? record.id ?? '';
}

/** The coordinator's latest snapshot per kind. Realtime is derived from the agency feed and
 * stale within minutes, so it never goes to R2 (that cost some 1.5 million writes a day): it
 * is held in memory and kept gzipped in the coordinator's own storage, a few rows per poll,
 * so an object evicted between polls reloads it instead of polling again. */
type HeldSnapshot = { snapshot: Omit<NormalizedRealtimeSnapshot, 'payload'>; payload: unknown[] | null; byKey?: Map<string, unknown[]>; etag: string };
type StoredSnapshot = { chunks: number; warnings?: string[] };
/** Held per coordinator (keyed by its storage), so it lives exactly as long as the object. */
const held = new WeakMap<DurableObjectStorage, Map<RealtimeFeedKind, HeldSnapshot>>();
let published = 0;
/** Compressed chunks stay below SQLite-backed storage's 2 MB value limit. */
const CHUNK_BYTES = 1_900_000;
const MAX_CHUNKS = 32;
const snapshotKey = (kind: RealtimeFeedKind) => `snapshot:${kind}`;
const chunkKey = (kind: RealtimeFeedKind, index: number) => `snapshot:${kind}:${index}`;

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export class RealtimeSnapshotStore {
  readonly #latest: Map<RealtimeFeedKind, HeldSnapshot>;
  readonly #restoring = new Map<RealtimeFeedKind, Promise<HeldSnapshot | undefined>>();
  constructor(private readonly storage: DurableObjectStorage) {
    let latest = held.get(storage);
    if (!latest) { latest = new Map(); held.set(storage, latest); }
    this.#latest = latest;
  }

  async publish<T>(kind: RealtimeFeedKind, snapshot: NormalizedRealtimeSnapshot<T>): Promise<void> {
    const { payload, etag: _etag, ...base } = snapshot;
    if (encode(base).length > METADATA_BYTES) throw new Error('Realtime metadata budget exceeded');
    // Any tag unique to this publish lets a reader holding the payload skip it.
    const entry: HeldSnapshot = { snapshot: base, payload: payload ?? null, etag: `${base.receivedAtSeconds}.${++published}.${Math.random().toString(36).slice(2, 10)}` };
    const bytes = await transform(new TextEncoder().encode(JSON.stringify({ snapshot: entry.snapshot, payload: entry.payload, etag: entry.etag })), new CompressionStream('gzip'));
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) chunks.push(bytes.slice(at, at + CHUNK_BYTES));
    if (chunks.length > MAX_CHUNKS) throw new Error('Realtime payload byte budget exceeded');
    const previous = await this.storage.get<StoredSnapshot>(snapshotKey(kind));
    // One atomic put: the chunk count and its chunks change together.
    await this.storage.put({ [snapshotKey(kind)]: { chunks: chunks.length } satisfies StoredSnapshot, ...Object.fromEntries(chunks.map((chunk, index) => [chunkKey(kind, index), chunk])) });
    if (previous && previous.chunks > chunks.length) await this.storage.delete(Array.from({ length: previous.chunks - chunks.length }, (_, index) => chunkKey(kind, chunks.length + index)));
    this.#latest.set(kind, entry);
  }

  /** The held snapshot, reloaded from storage after an eviction. */
  #held(kind: RealtimeFeedKind): Promise<HeldSnapshot | undefined> {
    const latest = this.#latest.get(kind);
    if (latest) return Promise.resolve(latest);
    let restoring = this.#restoring.get(kind);
    if (!restoring) {
      restoring = (async () => {
        const stored = await this.storage.get<StoredSnapshot>(snapshotKey(kind));
        if (!stored || stored.chunks < 1 || stored.chunks > MAX_CHUNKS) return undefined;
        const parts = await this.storage.get<Uint8Array>(Array.from({ length: stored.chunks }, (_, index) => chunkKey(kind, index)));
        const chunks = Array.from({ length: stored.chunks }, (_, index) => parts.get(chunkKey(kind, index)));
        if (chunks.some(chunk => !chunk)) return undefined;
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk!.length, 0));
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk!, offset); offset += chunk!.length; }
        const entry = JSON.parse(new TextDecoder().decode(await transform(bytes, new DecompressionStream('gzip')))) as HeldSnapshot;
        if (stored.warnings?.length) entry.snapshot = { ...entry.snapshot, warnings: [...new Set([...(entry.snapshot.warnings ?? []), ...stored.warnings])].slice(0, 32) };
        // A publish while this was loading wins.
        if (!this.#latest.has(kind)) this.#latest.set(kind, entry);
        return this.#latest.get(kind);
      })().finally(() => this.#restoring.delete(kind));
      this.#restoring.set(kind, restoring);
    }
    return restoring;
  }

  async read<T>(kind: RealtimeFeedKind, version: StaticVersion, stopIds?: string[]): Promise<NormalizedRealtimeSnapshot<T> | null> {
    const latest = await this.#held(kind);
    if (!latest) return null;
    const base = latest.snapshot;
    if (!sameStaticVersion(base.version, version)) return { ...base, payload: null, degraded: true, warnings: ['SCHEDULE_REALTIME_MISMATCH'] };
    if (!stopIds || latest.payload === null) return { ...base, payload: latest.payload as T[] | null, ...(latest.payload ? { etag: latest.etag } : {}) };
    // Index by stop on the first filtered read: a plan asks for ~200 of SF Bay's 90,000 rows.
    if (!latest.byKey) {
      latest.byKey = new Map();
      for (const record of latest.payload) { const key = indexKey(record), rows = latest.byKey.get(key); if (rows) rows.push(record); else latest.byKey.set(key, [record]); }
    }
    return { ...base, payload: [...new Set(stopIds)].flatMap(stop => latest.byKey!.get(stop) ?? []) as T[] };
  }

  /** Whether this coordinator has a snapshot of `kind`, in memory or stored. */
  async holds(kind: RealtimeFeedKind): Promise<boolean> { return !!await this.#held(kind); }

  async warn(kind: RealtimeFeedKind, warning: string): Promise<void> {
    const latest = await this.#held(kind), stored = await this.storage.get<StoredSnapshot>(snapshotKey(kind));
    if (!latest || !stored) return;
    const warnings = [...new Set([...(latest.snapshot.warnings ?? []), warning])].slice(0, 32);
    latest.snapshot = { ...latest.snapshot, warnings };
    await this.storage.put(snapshotKey(kind), { ...stored, warnings } satisfies StoredSnapshot);
  }
}

/** One configured provider coordinator owns all requests using its credential.
 * Reserve before network I/O; failures consume the same rolling-hour budget. */
export class ApiKeyQuota {
  constructor(private readonly storage: DurableObjectStorage,
    private readonly budget: { requestsPerHour: number; safetyFactor: number; reserveForStatic: number }) {}
  async claim(kind: RealtimeFeedKind | 'static', nowSeconds: number): Promise<boolean> {
    return this.storage.transaction(async txn => {
      const limit = Math.floor(this.budget.requestsPerHour * this.budget.safetyFactor);
      const records = (await txn.get<{ at: number; kind: string }[]>('quota:sfbay:511') ?? []).filter(r => r.at > nowSeconds - 3600);
      if (records.length >= limit || (kind !== 'static' && records.filter(r => r.kind !== 'static').length >= limit - this.budget.reserveForStatic)) return false;
      records.push({ at: nowSeconds, kind });
      await txn.put('quota:sfbay:511', records);
      return true;
    });
  }
}
