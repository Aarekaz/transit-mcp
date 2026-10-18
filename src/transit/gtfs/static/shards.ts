import type { ScheduleShard } from './schema';

/** Locale-independent canonical JSON is used only for the metadata section. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return item;
  });
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Little endian: magic MTS2, metadata byte length, row count, row width.
// Followed by canonical metadata, zero padding to 4 bytes, then Uint32 rows:
// trip index, stop index, sequence, arrival, departure, pickup, dropoff,
// timepoint, headsign string index. 0xffffffff represents an unknown time.
const HEADER_BYTES = 16;
const ROW_WORDS = 9;
const UNKNOWN_TIME = 0xffffffff;

export function encodeScheduleShard(shard: ScheduleShard): Uint8Array {
  const stopIndexes = new Map(shard.stops.map((stop, index) => [stop.ref, index]));
  const headsigns = [...new Set(shard.trips.flatMap(trip => trip.stopTimes.map(time => time.headsign)))].sort();
  const headsignIndexes = new Map(headsigns.map((value, index) => [value, index]));
  const rows: number[] = [];
  const trips = shard.trips.map((trip, tripIndex) => {
    const { stopTimes, ...metadata } = trip;
    for (const time of stopTimes) {
      const stopIndex = stopIndexes.get(time.stopRef);
      if (stopIndex === undefined) throw new Error('Timetable references an unknown stop');
      rows.push(tripIndex, stopIndex, time.sequence, time.arrivalSeconds ?? UNKNOWN_TIME,
        time.departureSeconds ?? UNKNOWN_TIME, time.pickupType, time.dropOffType, time.timepoint, headsignIndexes.get(time.headsign)!);
    }
    return metadata;
  });
  const metadata = new TextEncoder().encode(canonicalJson({ ...shard, trips, headsigns }));
  const offset = (HEADER_BYTES + metadata.length + 3) & ~3;
  const bytes = new Uint8Array(offset + rows.length * 4);
  bytes.set([77, 84, 83, 50]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, metadata.length, true);
  view.setUint32(8, rows.length / ROW_WORDS, true);
  view.setUint32(12, ROW_WORDS, true);
  bytes.set(metadata, HEADER_BYTES);
  rows.forEach((value, index) => view.setUint32(offset + index * 4, value, true));
  return bytes;
}

/** Decode only after the manifest's SHA-256 has been verified by the loader. */
export function decodeScheduleShard(bytes: Uint8Array): ScheduleShard {
  try {
    if (bytes.length < HEADER_BYTES || bytes[0] !== 77 || bytes[1] !== 84 || bytes[2] !== 83 || bytes[3] !== 50) throw new Error();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metadataLength = view.getUint32(4, true), rowCount = view.getUint32(8, true);
    const offset = Math.ceil((HEADER_BYTES + metadataLength) / 4) * 4;
    if (view.getUint32(12, true) !== ROW_WORDS || offset + rowCount * ROW_WORDS * 4 !== bytes.length) throw new Error();
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength))) as ScheduleShard & { headsigns: string[] };
    if (metadata.schemaVersion !== 2 || !Array.isArray(metadata.trips) || !Array.isArray(metadata.stops) || !Array.isArray(metadata.headsigns)) throw new Error();
    const { headsigns, ...shard } = metadata;
    for (const trip of shard.trips) trip.stopTimes = [];
    for (let row = 0; row < rowCount; row++) {
      const word = (column: number) => view.getUint32(offset + (row * ROW_WORDS + column) * 4, true);
      const trip = shard.trips[word(0)], stop = shard.stops[word(1)], headsign = headsigns[word(8)];
      if (!trip || !stop || typeof headsign !== 'string' || word(5) > 3 || word(6) > 3 || word(7) > 1) throw new Error();
      const arrivalSeconds = word(3) === UNKNOWN_TIME ? null : word(3);
      const departureSeconds = word(4) === UNKNOWN_TIME ? null : word(4);
      const previous = trip.stopTimes.at(-1);
      if (previous && previous.sequence >= word(2)) throw new Error();
      if ((arrivalSeconds === null) !== (departureSeconds === null) ||
        (arrivalSeconds !== null && departureSeconds !== null && departureSeconds < arrivalSeconds)) throw new Error();
      trip.stopTimes.push({ stopRef: stop.ref, sequence: word(2), arrivalSeconds, departureSeconds,
        pickupType: word(5), dropOffType: word(6), timepoint: word(7), headsign });
    }
    return shard;
  } catch {
    throw new Error('Invalid schedule shard');
  }
}
