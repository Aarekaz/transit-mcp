import { buildServiceCalendars } from '../static/compiler';
import { csvRecords, parseCsvRecord, parseGtfsCsv } from '../static/csv';
import { readZipDirectory, zipEntryStream, zipEntryText, type ZipEntry } from '../static/zip';
import { isServiceActive } from '../../planner/service-day';

/** Tables whose changes can be placed on service days from trips.txt alone. */
const LOCALIZABLE = new Set(['trips.txt', 'stop_times.txt']);

async function records(bytes: Uint8Array, entry: ZipEntry): Promise<string[]> {
  const rows: string[] = [];
  for await (const record of csvRecords(zipEntryStream(bytes, entry))) rows.push(record);
  return rows;
}

/**
 * Whether a new archive changes service on any of `dates`, judged from the small tables
 * only. Live predictions match today's trips by ID, so a change near now must be built at
 * once; MTA's hourly supplement mostly moves planned work days ahead, which can wait.
 * Anything not placeable from trips.txt (stops, calendars, a stop_times edit without a
 * trips.txt change) counts as near-term: when unsure, stay fresh.
 */
export async function changesServiceOn(previous: Uint8Array, next: Uint8Array, dates: readonly string[]): Promise<boolean> {
  const before = readZipDirectory(previous), after = readZipDirectory(next);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(name => {
    const a = before.get(name), b = after.get(name);
    return !a || !b || a.size !== b.size || a.crc32 !== b.crc32;
  });
  if (!changed.length) return false;
  if (changed.some(name => !LOCALIZABLE.has(name)) || !changed.includes('trips.txt')) return true;
  const [old, current] = await Promise.all([records(previous, before.get('trips.txt')!), records(next, after.get('trips.txt')!)]);
  if (old[0] !== current[0]) return true;
  const service = parseCsvRecord(current[0]!).indexOf('service_id');
  if (service < 0) return true;
  // Rows added, removed or edited; an edited trip shows up in both lists.
  const kept = new Set(old), present = new Set(current);
  const rows = [...current.slice(1).filter(row => !kept.has(row)), ...old.slice(1).filter(row => !present.has(row))];
  const services = new Set(rows.map(row => parseCsvRecord(row)[service]));
  const text = (name: string) => after.get(name) ? zipEntryText(next, after.get(name)!) : Promise.resolve('');
  const calendars = buildServiceCalendars(parseGtfsCsv(await text('calendar.txt')), parseGtfsCsv(await text('calendar_dates.txt')));
  return [...services].some(id => id === undefined || !calendars[id] || dates.some(date => isServiceActive(calendars[id]!, date)));
}
