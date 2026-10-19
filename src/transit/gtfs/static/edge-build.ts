import type { CoverageManifest } from '../../core/coverage';
import { formatEntityRef, type TransitRef } from '../../core/refs';
import { isServiceActive, serviceDateAtInstant, shiftServiceDate } from '../../planner/service-day';
import { buildServiceCalendars, compileSchedule } from './compiler';
import { csvRecords, parseCsvRecord, parseGtfsCsv } from './csv';
import { partitionSchedule } from './partition';
import type { ArtifactManifestV2, CompileScheduleInput, DiscoveryIndex, GtfsScheduleFiles } from './schema';
import { canonicalJson, sha256 } from './shards';
import { parseGtfsTime } from './time';
import { readZipDirectory, zipEntryStream, zipEntryText, type ZipEntry } from './zip';

/** Builds the same v2 artifact as the offline compiler, one service date at a time, so it
 * fits a Worker: the large stop_times table is only ever streamed, and each part is
 * compiled with the unchanged compiler and partitioner under the feed's shared identity. */
export interface EdgeSource {
  coverage: CoverageManifest; feedId: string; url: string; retrievedAt: string;
  exclude?: { files: string[]; reason: string };
}
export type FeedIdentity = NonNullable<CompileScheduleInput['identity']>;
export interface ScanResult {
  identity: FeedIdentity; dates: string[];
  sources: ArtifactManifestV2['sources']; agencyTimezones: ArtifactManifestV2['agencyTimezones'];
  discovery: ArtifactManifestV2['discoveries'][number]; discoveryBytes: Uint8Array;
  stats: { trips: number; stops: number; routes: number };
}
export interface DateBuild { date: string; objects: { key: string; bytes: Uint8Array }[]; descriptors: ArtifactManifestV2['shards']; trips: number }

const MANDATORY = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'] as const;
const SMALL = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt', 'frequencies.txt', 'transfers.txt', 'pathways.txt'] as const;

async function open(archive: Uint8Array, source: EdgeSource) {
  const entries = readZipDirectory(archive);
  for (const name of MANDATORY) if (!entries.has(name)) throw new Error(`Missing ${name}`);
  const excluded = new Set(source.exclude?.files ?? []);
  const text: Partial<Record<typeof SMALL[number], string>> = {};
  for (const name of SMALL) { const entry = entries.get(name); if (entry && !excluded.has(name)) text[name] = await zipEntryText(archive, entry); }
  if (text['frequencies.txt'] && parseGtfsCsv(text['frequencies.txt']).length) throw new Error('Frequency-based trips are not supported by banded builds');
  return { stopTimes: entries.get('stop_times.txt')!, text };
}

/** Streams stop_times once, yielding parsed fields by column name. */
async function* stopTimeRows(archive: Uint8Array, entry: ZipEntry): AsyncGenerator<{ raw: string; field: (name: string) => string }> {
  let columns: Map<string, number> | undefined;
  for await (const raw of csvRecords(zipEntryStream(archive, entry))) {
    const fields = parseCsvRecord(raw);
    if (!columns) {
      columns = new Map(fields.map((name, index) => [name, index]));
      if (columns.size !== fields.length) throw new Error('Duplicate GTFS header');
      for (const name of ['trip_id', 'stop_id', 'stop_sequence']) if (!columns.has(name)) throw new Error(`Missing required GTFS field: ${name}`);
      yield { raw, field: () => '' }; // header
      continue;
    }
    if (fields.length !== columns.size) throw new Error(`stop_times.txt row has ${fields.length} columns; expected ${columns.size}`);
    const index = columns;
    yield { raw, field: name => { const at = index.get(name); return at === undefined ? '' : fields[at]!; } };
  }
}

function filesFor(text: Awaited<ReturnType<typeof open>>['text'], trips: string, stopTimes: string): GtfsScheduleFiles {
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries(text)) if (value !== undefined) files[name] = value;
  return { ...files, 'trips.txt': trips, 'stop_times.txt': stopTimes } as GtfsScheduleFiles;
}

export async function feedIdentity(archive: Uint8Array, source: EdgeSource): Promise<Omit<FeedIdentity, 'maxStopTimeSeconds'>> {
  const archiveSha256 = await sha256(archive);
  if (!source.exclude?.files.length) return { sha256: archiveSha256, archiveSha256 };
  const excludedFiles = [...source.exclude.files].sort();
  return { sha256: await sha256(new TextEncoder().encode(`${archiveSha256}\nexclude:${excludedFiles.join(',')}`)), archiveSha256,
    derivedFrom: { archiveSha256, excludedFiles, reason: source.exclude.reason } };
}

/** One pass over the feed: identity, feed-wide timetable bound, discovery index and the
 * published window (yesterday, for overnight service, through windowDays ahead). */
export async function scanArchive(archive: Uint8Array, source: EdgeSource, windowDays: number, now: number): Promise<ScanResult> {
  const { stopTimes, text } = await open(archive, source);
  const trips = parseGtfsCsv(text['trips.txt']!), stops = parseGtfsCsv(text['stops.txt']!);
  const tripRoutes = new Map<string, string>();
  for (const trip of trips) {
    if (!trip.trip_id || !trip.route_id) throw new Error('Missing trip identity');
    if (tripRoutes.has(trip.trip_id)) throw new Error('duplicate trip_id');
    tripRoutes.set(trip.trip_id, trip.route_id);
  }
  const parents = new Map(stops.map(stop => [stop.stop_id!, stop.parent_station ?? '']));
  // Thousands of distinct stops and routes across millions of rows: format each once.
  const refs = new Map<string, TransitRef>();
  const ref = (kind: 'stop' | 'route', id: string) => {
    const key = `${kind}\u0000${id}`;
    let value = refs.get(key);
    if (!value) { value = formatEntityRef({ coverage: source.coverage.id, feed: source.feedId, kind, id }); refs.set(key, value); }
    return value;
  };
  const stopRoutes = new Map<TransitRef, Set<TransitRef>>();
  let maxStopTimeSeconds = 0, header = true;
  for await (const row of stopTimeRows(archive, stopTimes)) {
    if (header) { header = false; continue; }
    const route = tripRoutes.get(row.field('trip_id')), stop = row.field('stop_id');
    if (!route) throw new Error('unknown trip reference');
    if (!parents.has(stop)) throw new Error('unknown stop reference');
    const departure = row.field('departure_time');
    if (departure) maxStopTimeSeconds = Math.max(maxStopTimeSeconds, parseGtfsTime(departure).totalSeconds);
    const routeRef = ref('route', route);
    for (const id of [stop, parents.get(stop)!].filter(Boolean)) {
      const key = ref('stop', id), set = stopRoutes.get(key) ?? new Set<TransitRef>(); set.add(routeRef); stopRoutes.set(key, set);
    }
  }
  const agencies = parseGtfsCsv(text['agency.txt']!), timezone = agencies[0]?.agency_timezone;
  if (!timezone || agencies.some(agency => agency.agency_timezone !== timezone)) throw new Error('A single agency timezone is required');
  const feedInfo = text['feed_info.txt'] ? parseGtfsCsv(text['feed_info.txt']) : [];
  const today = serviceDateAtInstant(now, timezone);
  let start = shiftServiceDate(today, -1), end = shiftServiceDate(today, windowDays);
  for (const info of feedInfo) {
    if (info.feed_start_date && info.feed_start_date > start) start = info.feed_start_date;
    if (info.feed_end_date && info.feed_end_date < end) end = info.feed_end_date;
  }
  if (start > end || end < today) throw new Error('Source schedule does not cover today');
  const dates: string[] = [];
  for (let date = start; date <= end; date = shiftServiceDate(date, 1)) dates.push(date);
  const identity: FeedIdentity = { ...await feedIdentity(archive, source), maxStopTimeSeconds };
  // Stops, routes and agencies compile without timetable rows; discovery's trip IDs and
  // stop routes are feed-wide, exactly as a whole-feed compile reports them.
  const tripsHeader = text['trips.txt']!.slice(0, text['trips.txt']!.search(/\r?\n/));
  const stopTimesHeader = (await csvRecords(zipEntryStream(archive, stopTimes)).next()).value as string;
  const skeleton = await compileSchedule({ coverage: source.coverage, feedId: source.feedId, files: filesFor(text, `${tripsHeader}\n`, `${stopTimesHeader}\n`),
    window: { startDate: start, endDate: end }, source: { url: source.url, retrievedAt: source.retrievedAt }, identity });
  const discovery: DiscoveryIndex = { ...skeleton.discovery, tripProviderIds: [...tripRoutes.keys()].sort(),
    stopRoutes: Object.fromEntries([...stopRoutes].map(([stop, routes]) => [stop, [...routes].sort()])) };
  const discoveryBytes = new TextEncoder().encode(canonicalJson(discovery)), discoveryHash = await sha256(discoveryBytes);
  return { identity, dates, sources: skeleton.manifest.sources, agencyTimezones: skeleton.manifest.agencyTimezones,
    discovery: { feedId: source.feedId, key: `artifacts/${source.coverage.id}/v2/${source.feedId}/discovery/${discoveryHash}.json`, sha256: discoveryHash, byteLength: discoveryBytes.length },
    discoveryBytes, stats: { trips: tripRoutes.size, stops: discovery.stops.length, routes: discovery.routes.length } };
}

/** One service date: stream stop_times keeping only that date's trips, then compile each
 * first-departure band separately. Output equals partitioning a whole-feed compile. */
export async function buildServiceDate(archive: Uint8Array, source: EdgeSource, identity: FeedIdentity, date: string, bandSeconds: number): Promise<DateBuild> {
  const { stopTimes, text } = await open(archive, source);
  const calendars = buildServiceCalendars(text['calendar.txt'] ? parseGtfsCsv(text['calendar.txt']) : [], text['calendar_dates.txt'] ? parseGtfsCsv(text['calendar_dates.txt']) : []);
  const tripRecords = new Map<string, string>();
  let tripsHeader: string | undefined, tripColumns: Map<string, number> | undefined;
  for await (const raw of csvRecords(new Blob([text['trips.txt']!]).stream())) {
    const fields = parseCsvRecord(raw);
    if (!tripColumns) { tripsHeader = raw; tripColumns = new Map(fields.map((name, index) => [name, index])); continue; }
    const service = fields[tripColumns.get('service_id')!]!, calendar = calendars[service];
    if (!calendar) throw new Error('unknown service reference');
    if (isServiceActive(calendar, date)) tripRecords.set(fields[tripColumns.get('trip_id')!]!, raw);
  }
  const active = new Map<string, { lines: string[]; firstSequence: number; firstDeparture: number | null; timed: number }>();
  let stopTimesHeader = '';
  for await (const row of stopTimeRows(archive, stopTimes)) {
    if (!stopTimesHeader) { stopTimesHeader = row.raw; continue; }
    const trip = row.field('trip_id');
    if (!tripRecords.has(trip)) continue;
    const entry = active.get(trip) ?? { lines: [], firstSequence: Infinity, firstDeparture: null, timed: 0 };
    const sequence = Number(row.field('stop_sequence')), departure = row.field('departure_time');
    if (sequence < entry.firstSequence) { entry.firstSequence = sequence; entry.firstDeparture = departure ? parseGtfsTime(departure).totalSeconds : null; }
    if (departure) entry.timed++;
    entry.lines.push(row.raw); active.set(trip, entry);
  }
  const bands = new Map<number, string[]>();
  let usable = 0;
  for (const [trip, entry] of active) {
    // Partitioning drops GTFS-unusable trips and trips without a first departure.
    if (entry.timed < 2 || entry.firstDeparture === null) continue;
    usable++;
    const band = Math.floor(entry.firstDeparture / bandSeconds), list = bands.get(band) ?? []; list.push(trip); bands.set(band, list);
  }
  const compileFor = (trips: string[]) => compileSchedule({ coverage: source.coverage, feedId: source.feedId, identity,
    files: filesFor(text, [tripsHeader!, ...trips.map(trip => tripRecords.get(trip)!)].join('\n') + '\n',
      [stopTimesHeader, ...trips.flatMap(trip => active.get(trip)!.lines)].join('\n') + '\n'),
    window: { startDate: date, endDate: date }, source: { url: source.url, retrievedAt: source.retrievedAt } });
  const result: DateBuild = { date, objects: [], descriptors: [], trips: usable };
  // A date with no usable service still publishes one object, so it reads as "no service".
  const parts = usable ? [...bands.keys()].sort((a, b) => a - b).map(band => bands.get(band)!) : [[]];
  for (const trips of parts) {
    const partitioned = await partitionSchedule(await compileFor(trips), bandSeconds);
    result.objects.push(...partitioned.objects.filter(object => !object.key.includes('/discovery/')));
    result.descriptors.push(...partitioned.manifest.shards);
  }
  return result;
}
