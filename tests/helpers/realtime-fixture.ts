import { compileSchedule } from '../../src/transit/gtfs/static/compiler';
import { SFBAY_COVERAGE } from '../../src/regions/sfbay';
import type { GtfsScheduleFiles } from '../../src/transit/gtfs/static/schema';

export async function realtimeFixture(frequencies = '', overrides: Partial<GtfsScheduleFiles> = {}) {
  const files: GtfsScheduleFiles = {
    'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\nA,Muni,https://sfmta.com,America/Los_Angeles\n',
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nS,Station,37,-122\nP,Platform,37,-122\nQ,Last,37,-122\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nR,A,N,Judah,0\n',
    'trips.txt': 'route_id,service_id,trip_id\nR,D,T\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,S,1\nT,08:05:00,08:05:00,P,2\nT,08:10:00,08:10:00,S,3\nT,08:15:00,08:15:00,Q,4\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nD,1,1,1,1,1,1,1,20260101,20261231\n',
    ...(frequencies ? { 'frequencies.txt': frequencies } : {}),
    ...overrides,
  };
  return compileSchedule({ coverage: SFBAY_COVERAGE, feedId: 'sf511', files,
    window: { startDate: '20260101', endDate: '20261231' },
    source: { url: 'https://511.org/open-data/transit', retrievedAt: '2026-10-18T00:00:00Z' } });
}

/** Storage boundaries only: normalization, hashing, partitioning and quota remain real. */
export function memoryStorage() {
  const values = new Map<string, unknown>();
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [name, item] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) values.set(name as string, structuredClone(item));
    },
    delete: async (key: string) => values.delete(key),
    transaction: async <T>(callback: (txn: unknown) => Promise<T>) => callback(storage),
    getAlarm: async () => 1, setAlarm: async () => {},
  };
  const bucket = {
    get: async (key: string) => {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { size: bytes.byteLength, body: new Response(bytes).body,
        arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes) };
    },
    put: async (key: string, value: Uint8Array | string) => { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value.slice()); },
    delete: async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); },
  };
  return { values, objects, reads, storage: storage as unknown as DurableObjectStorage, bucket: bucket as unknown as R2Bucket };
}
