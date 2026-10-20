import type { RealtimeFeedKind } from '../../../regions/types';
import { count, phase } from '../../trace';
import type { ArtifactManifestV2 } from '../static/schema';
import { canonicalJson, sha256 } from '../static/shards';

export interface StaticVersion { artifactVersion: string; sourceVersions: Record<string, string> }
export interface NormalizedRealtimeSnapshot<T = unknown> {
  version: StaticVersion; producerTimestampSeconds?: number; receivedAtSeconds: number;
  payload: T[] | null; warnings?: string[]; degraded?: boolean;
  /** Content tag of the complete payload (from its shard hashes); absent for filtered reads. */
  etag?: string;
}
interface ShardDescriptor { key: string; sha256: string; byteLength: number; partition: number }
interface SnapshotMetadata extends Omit<NormalizedRealtimeSnapshot, 'payload'> { shards: ShardDescriptor[] }
const encode = (value: unknown) => new TextEncoder().encode(`${canonicalJson(value)}\n`);
const PARTITIONS = 64;
const SHARD_BYTES = 256 * 1024;
const PAYLOAD_BYTES = 32 * 1024 * 1024;
// Current/previous indexes and garbage journals for three feeds (<120 KiB each)
// plus quota/poll timestamps stay below 2 MiB.
// Each value also stays below the Durable Object's per-value limit.
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

/** R2 round trips from a Durable Object are slow; overlap a bounded number at a time
 * so one poll finishes well inside its interval. Results keep input order. */
const R2_CONCURRENCY = 16;
async function bounded<T, R>(items: readonly T[], operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(R2_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await operation(items[index]!); }
  }));
  return results;
}

/** A shard is a record array, or `{ columns, rows }` with null for an absent field. */
function expandShard(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const { columns, rows } = value as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(columns) || !Array.isArray(rows) || !columns.every(column => typeof column === 'string')) throw new Error('Realtime shard integrity failure');
  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error('Realtime shard integrity failure');
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => { if (row[index] !== null) record[column] = row[index]; });
    return record;
  });
}

function partition(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % PARTITIONS;
}
function indexKey(value: unknown): string {
  const record = value as { stopId?: string; entityId?: string; id?: string };
  return record.stopId ?? record.entityId ?? record.id ?? '';
}

/** The payload's content identity: its content-addressed shards, in order. */
const payloadIdentity = (shards: readonly ShardDescriptor[]) => shards.map(shard => shard.sha256).join('.');

export class RealtimeSnapshotStore {
  /** The last complete payload per kind, kept by the coordinator that published or read it.
   * A read whose metadata names the same shards serves it without R2, hashing or parsing. */
  readonly #latest = new Map<RealtimeFeedKind, { identity: string; etag: string; payload: unknown[] }>();
  /** Latest metadata per kind. This coordinator is its storage's only writer, so reads need
   * not wait on storage (they queued behind a poll's writes for seconds). */
  readonly #metadata = new Map<RealtimeFeedKind, SnapshotMetadata>();
  /** A whole-snapshot load in flight, shared by the filtered reads waiting on it. */
  readonly #loading = new Map<RealtimeFeedKind, Promise<NormalizedRealtimeSnapshot<unknown> | null>>();
  private readonly prefix: string;
  /** `feedId` scopes a coverage's non-primary feeds: every coordinator collects only the
   * objects it wrote. The primary feed keeps the coverage-level prefix. */
  constructor(private readonly storage: DurableObjectStorage, private readonly bucket: R2Bucket, coverageId = 'sfbay', feedId?: string) {
    if (!/^[a-z0-9_]+$/.test(coverageId) || feedId !== undefined && !/^[a-z0-9_]+$/.test(feedId)) throw new Error('Invalid coverage namespace');
    this.prefix = feedId === undefined ? `realtime/${coverageId}` : `realtime/${coverageId}/feeds/${feedId}`;
  }

  async publish<T>(kind: RealtimeFeedKind, snapshot: NormalizedRealtimeSnapshot<T>): Promise<void> {
    const { payload, ...base } = snapshot;
    if (encode(base).length > METADATA_BYTES) throw new Error('Realtime metadata budget exceeded');
    const partitions = new Map<number, Record<string, unknown>[]>();
    for (const record of payload ?? []) {
      const key = partition(indexKey(record)), records = partitions.get(key) ?? [];
      records.push(record as Record<string, unknown>); partitions.set(key, records);
    }
    // Each shard is either a plain array of records or, when no record holds a top-level null,
    // columns named once and rows of values (absent = null): field names are about half of a
    // trip-update row, and a city's buses publish some 80,000 rows.
    const groups = new Map<number, { header: string; rows: string[] }>(); let total = 0;
    for (const [part, records] of partitions) {
      const columns = [...new Set(records.flatMap(record => Object.keys(record).filter(key => record[key] !== undefined)))].sort();
      const columnar = columns.length <= 64 && !records.some(record => Object.values(record).some(value => value === null));
      const rows = records.map(record => columnar ? canonicalJson(columns.map(column => record[column] ?? null)) : canonicalJson(record));
      for (const row of rows) {
        const bytes = new TextEncoder().encode(row).length + 1;
        total += bytes;
        if (bytes > SHARD_BYTES - 1024 || total > PAYLOAD_BYTES) throw new Error('Realtime payload byte budget exceeded');
      }
      groups.set(part, { header: columnar ? `{"columns":${canonicalJson(columns)},"rows":[` : '[', rows });
    }
    const objects: { descriptor: ShardDescriptor; bytes: Uint8Array }[] = [];
    for (const [part, { header, rows: records }] of groups) {
      let batch: string[] = [], size = header.length + 2;
      const flush = async () => {
        if (!batch.length) return;
        const bytes = new TextEncoder().encode(`${header}${batch.join(',')}${header === '[' ? ']' : ']}'}`), hash = await sha256(bytes);
        objects.push({ bytes, descriptor: { partition: part, byteLength: bytes.length, sha256: hash,
          key: `${this.prefix}/${snapshot.version.artifactVersion}/${kind}/${hash}.json` } });
        batch = []; size = header.length + 2;
      };
      for (const record of records) {
        const length = new TextEncoder().encode(record).length + 1;
        if (size + length > SHARD_BYTES) await flush();
        batch.push(record); size += length;
      }
      await flush();
    }
    const metadata: SnapshotMetadata = { ...base, shards: objects.map(o => o.descriptor) };
    if (encode(metadata).length > METADATA_BYTES) throw new Error('Realtime metadata budget exceeded');
    const garbageKey = `realtime:${kind}:garbage`;
    const pending = await this.storage.get<string[]>(garbageKey) ?? [];
    if (pending.length) await this.bucket.delete(pending);
    const current = await this.storage.get<SnapshotMetadata>(`realtime:${kind}`);
    const previous = await this.storage.get<SnapshotMetadata>(`realtime:${kind}:previous`);
    const retainedBefore = new Set([...(current?.shards ?? []), ...(previous?.shards ?? [])].map(shard => shard.key));
    // Journal provisional keys before uploading. A crash/failed put can be cleaned
    // on restoration, while current/previous objects are never provisional garbage.
    await this.storage.put(garbageKey, objects.map(object => object.descriptor.key).filter(key => !retainedBefore.has(key)));
    // Immutable payload first; a failed write never publishes a partial snapshot.
    await bounded(objects, object => this.bucket.put(object.descriptor.key, object.bytes));
    const expired = await this.storage.transaction(async txn => {
      const current = await txn.get<SnapshotMetadata>(`realtime:${kind}`);
      const previous = await txn.get<SnapshotMetadata>(`realtime:${kind}:previous`);
      const retained = new Set([...metadata.shards, ...(current?.shards ?? [])].map(shard => shard.key));
      const expired = (previous?.shards ?? []).filter(shard => !retained.has(shard.key)).map(shard => shard.key);
      await txn.put({ [`realtime:${kind}`]: metadata, ...(current ? { [`realtime:${kind}:previous`]: current } : {}), [garbageKey]: expired });
      this.#metadata.set(kind, metadata);
      return expired;
    });
    if (expired.length) await this.bucket.delete(expired);
    await this.storage.delete(garbageKey);
    const identity = payloadIdentity(metadata.shards);
    this.#latest.set(kind, { identity, etag: await sha256(new TextEncoder().encode(identity)), payload: payload ?? [] });
  }

  async read<T>(kind: RealtimeFeedKind, version: StaticVersion, stopIds?: string[]): Promise<NormalizedRealtimeSnapshot<T> | null> {
    let metadata = this.#metadata.get(kind);
    if (!metadata) {
      metadata = await this.storage.get<SnapshotMetadata>(`realtime:${kind}`);
      if (!metadata) return null;
      this.#metadata.set(kind, metadata);
    }
    if (encode(metadata).length > METADATA_BYTES) throw new Error('Realtime metadata budget exceeded');
    const { shards, ...base } = metadata;
    if (!sameStaticVersion(metadata.version, version)) return { ...base, payload: null, degraded: true, warnings: ['SCHEDULE_REALTIME_MISMATCH'] };
    const identity = payloadIdentity(shards), resident = this.#latest.get(kind);
    if (resident?.identity === identity) {
      const wanted = stopIds && new Set(stopIds);
      return { ...base, payload: (wanted ? resident.payload.filter(record => wanted.has(indexKey(record))) : resident.payload) as T[], ...(wanted ? {} : { etag: resident.etag }) };
    }
    // Not resident (a restarted coordinator): load the whole snapshot once and filter in
    // memory. Reading partitions per request re-parsed nearly all of them for each plan.
    if (stopIds) {
      const loading = this.#loading.get(kind) ?? this.read<T>(kind, version).finally(() => this.#loading.delete(kind));
      this.#loading.set(kind, loading);
      const whole = await loading as NormalizedRealtimeSnapshot<T> | null, wanted = new Set(stopIds);
      if (!whole || whole.payload === null) return whole;
      const { etag: _etag, ...rest } = whole;
      return { ...rest, payload: whole.payload.filter(record => wanted.has(indexKey(record))) };
    }
    const chosen = shards;
    let total = 0;
    for (const descriptor of chosen) {
      total += descriptor.byteLength;
      if (descriptor.byteLength > SHARD_BYTES || total > PAYLOAD_BYTES) throw new Error('Realtime payload byte budget exceeded');
    }
    // Shard order is preserved; only the fetches overlap.
    const parts = await bounded(chosen, async descriptor => {
      const bytes = await readBoundedObject(this.bucket, descriptor.key, SHARD_BYTES);
      if (bytes.length !== descriptor.byteLength || await sha256(bytes) !== descriptor.sha256) throw new Error('Realtime shard integrity failure');
      const records = expandShard(JSON.parse(new TextDecoder().decode(bytes))) as T[];
      return records;
    });
    const payload = parts.flat(), etag = await sha256(new TextEncoder().encode(identity));
    this.#latest.set(kind, { identity, etag, payload });
    return { ...base, payload, etag };
  }

  async warn(kind: RealtimeFeedKind, warning: string): Promise<void> {
    const metadata = await this.storage.get<SnapshotMetadata>(`realtime:${kind}`);
    if (!metadata) return;
    metadata.warnings = [...new Set([...(metadata.warnings ?? []), warning])].slice(0, 32);
    if (encode(metadata).length > METADATA_BYTES) throw new Error('Realtime metadata budget exceeded');
    await this.storage.put(`realtime:${kind}`, metadata);
    this.#metadata.set(kind, metadata);
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
