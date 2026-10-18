export type CoverageId = string;
export type TransitEntityKind = 'agency' | 'route' | 'stop' | 'trip';
export type TransitRef = `tr:${CoverageId}:${string}:${TransitEntityKind}:${string}`;
export type TripInstanceRef = `tr:${CoverageId}:${string}:trip:${string}:${string}:${string}`;

export interface EntityRefInput {
  coverage: CoverageId;
  feed: string;
  kind: TransitEntityKind;
  id: string;
}

export interface TripInstanceRefInput extends Omit<EntityRefInput, 'kind'> {
  serviceDate: string;
  startTime: string;
}

export type ParsedTransitRef = EntityRefInput | (TripInstanceRefInput & { kind: 'trip' });

const namespace = /^[a-z0-9_]+$/;
const kinds = new Set<string>(['agency', 'route', 'stop', 'trip']);

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    return encode(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function validServiceDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

/** Invalid input never becomes an opaque reference or a provider-text error. */
export function parseTransitRef(ref: string): ParsedTransitRef | null {
  const parts = ref.split(':');
  if (parts.length !== 5 && parts.length !== 7) return null;
  const [prefix, coverage, feed, kind, encodedId, serviceDate, encodedStartTime] = parts;
  if (prefix !== 'tr' || !coverage || !namespace.test(coverage) || !feed || !namespace.test(feed) || !kind || !kinds.has(kind) || !encodedId) return null;
  const id = decode(encodedId);
  if (!id) return null;
  const entity = { coverage, feed, kind: kind as TransitEntityKind, id };
  if (parts.length === 5) return entity;
  if (kind !== 'trip' || !serviceDate || !validServiceDate(serviceDate) || !encodedStartTime) return null;
  const startTime = decode(encodedStartTime);
  if (!startTime || !/^\d{2,}:[0-5]\d:[0-5]\d$/.test(startTime)) return null;
  return { ...entity, kind: 'trip', serviceDate, startTime };
}

export function formatEntityRef(input: EntityRefInput): TransitRef {
  const ref = `tr:${input.coverage}:${input.feed}:${input.kind}:${encode(input.id)}`;
  if (parseTransitRef(ref)?.id !== input.id) throw new Error('Invalid transit reference');
  return ref as TransitRef;
}

export function formatTripInstanceRef(input: TripInstanceRefInput): TripInstanceRef {
  const ref = `${formatEntityRef({ ...input, kind: 'trip' })}:${input.serviceDate}:${encode(input.startTime)}`;
  if (!parseTransitRef(ref)) throw new Error('Invalid transit reference');
  return ref as TripInstanceRef;
}

export interface TransitCandidate {
  ref: TransitRef;
  providerId: string;
  name: string;
}

/** Exact matches remain candidates, even when multiple feeds use the same ID. */
export function findTransitCandidates<T extends TransitCandidate>(query: string, candidates: readonly T[]): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return candidates.filter(candidate =>
    candidate.providerId.trim().toLowerCase() === normalized || candidate.name.trim().toLowerCase() === normalized,
  ).sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}
