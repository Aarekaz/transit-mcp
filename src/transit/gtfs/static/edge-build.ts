import type { CoverageManifest } from '../../core/coverage';
import { formatEntityRef, type TransitRef } from '../../core/refs';
import { isServiceActive, serviceDateAtInstant, shiftServiceDate } from '../../planner/service-day';
import { buildServiceCalendars, compileSchedule } from './compiler';
import { csvRecordSpans, csvRecords, parseCsvRecord, parseGtfsCsv } from './csv';
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
  /** For ranged per-date reads of a stored uncompressed copy; never a step result. */
  stopTimes: { header: string; size: number; tripRanges: TripRanges; tripStarts: TripStarts };
}
export interface DateBuild { date: string; objects: { key: string; bytes: Uint8Array }[]; descriptors: ArtifactManifestV2['shards']; trips: number }

const MANDATORY = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'] as const;
const SMALL = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt', 'frequencies.txt', 'transfers.txt', 'pathways.txt'] as const;

export type ArchiveText = Awaited<ReturnType<typeof open>>['text'];
/** The archive's small tables (everything except stop_times and shapes), as text. */
export async function archiveText(archive: Uint8Array, source: EdgeSource): Promise<ArchiveText> {
  return (await open(archive, source)).text;
}

async function open(archive: Uint8Array, source: EdgeSource) {
  const entries = readZipDirectory(archive);
  for (const name of MANDATORY) if (!entries.has(name)) throw new Error(`Missing ${name}`);
  const excluded = new Set(source.exclude?.files ?? []);
  const text: Partial<Record<typeof SMALL[number], string>> = {};
  for (const name of SMALL) { const entry = entries.get(name); if (entry && !excluded.has(name)) text[name] = await zipEntryText(archive, entry); }
  if (text['frequencies.txt'] && parseGtfsCsv(text['frequencies.txt']).length) throw new Error('Frequency-based trips are not supported by banded builds');
  return { stopTimes: entries.get('stop_times.txt')!, text };
}

export type StopTimeRow = { raw: string; field: (name: string) => string; offset: number; end: number };
/** Parses stop_times records (header first) into rows with field access and byte spans. */
async function* stopTimeRecords(records: AsyncIterable<{ record: string; offset: number; end: number }>, header?: string): AsyncGenerator<StopTimeRow & { header?: true }> {
  let columns: Map<string, number> | undefined;
  const setColumns = (raw: string) => {
    const fields = parseCsvRecord(raw);
    columns = new Map(fields.map((name, index) => [name, index]));
    if (columns.size !== fields.length) throw new Error('Duplicate GTFS header');
    for (const name of ['trip_id', 'stop_id', 'stop_sequence']) if (!columns.has(name)) throw new Error(`Missing required GTFS field: ${name}`);
  };
  if (header !== undefined) setColumns(header);
  for await (const { record: raw, offset, end } of records) {
    if (!columns) { setColumns(raw); yield { raw, field: () => '', offset, end, header: true }; continue; }
    const fields = parseCsvRecord(raw);
    if (fields.length !== columns.size) throw new Error(`stop_times.txt row has ${fields.length} columns; expected ${columns.size}`);
    const index = columns;
    yield { raw, offset, end, field: name => { const at = index.get(name); return at === undefined ? '' : fields[at]!; } };
  }
}
const stopTimeRows = (archive: Uint8Array, entry: ZipEntry) => stopTimeRecords(csvRecordSpans(zipEntryStream(archive, entry)));

/** Each trip's byte ranges in the uncompressed stop_times.txt; feeds group a trip's rows,
 * and trip IDs that share a service usually sort together, so a day reads a few runs. */
export type TripRanges = Record<string, [start: number, end: number][]>;
/** Each trip's first stop_sequence, the departure there (-1 when untimed) and its number of
 * timed calls: enough to place it in a band, or drop it as unusable, before reading a row. */
export type TripStarts = Record<string, [firstSequence: number, firstDeparture: number, timedCalls: number]>;
/** Reads only the given trips' rows from a stored uncompressed stop_times.txt. Nearby
 * ranges are coalesced so a day needs few requests; rows of other trips are dropped. */
export async function* rangedStopTimes(read: (offset: number, length: number) => Promise<Uint8Array>, header: string, ranges: TripRanges,
  trips: ReadonlySet<string>, gapBytes = 256 * 1024): AsyncGenerator<StopTimeRow> {
  const wanted = [...trips].flatMap(trip => ranges[trip] ?? []).sort((a, b) => a[0] - b[0]);
  const blocks: [number, number][] = [];
  for (const [start, end] of wanted) {
    const last = blocks.at(-1);
    if (last && start - last[1] <= gapBytes) last[1] = Math.max(last[1], end); else blocks.push([start, end]);
  }
  for (const [start, end] of blocks) {
    const bytes = await read(start, end - start);
    if (bytes.length !== end - start) throw new Error('Short stop_times range read');
    const records = csvRecordSpans(new Blob([bytes]).stream());
    for await (const row of stopTimeRecords(records, header)) if (trips.has(row.field('trip_id'))) yield row;
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
  let maxStopTimeSeconds = 0, stopTimesHeader = '';
  const tripRanges: TripRanges = {}, tripStarts: TripStarts = {};
  for await (const row of stopTimeRows(archive, stopTimes)) {
    if (row.header) { stopTimesHeader = row.raw; continue; }
    const trip = row.field('trip_id'), ranges = tripRanges[trip] ??= [], last = ranges.at(-1);
    if (last && last[1] === row.offset) last[1] = row.end; else ranges.push([row.offset, row.end]);
    const route = tripRoutes.get(trip), stop = row.field('stop_id');
    if (!route) throw new Error('unknown trip reference');
    if (!parents.has(stop)) throw new Error('unknown stop reference');
    const departure = row.field('departure_time'), departureSeconds = departure ? parseGtfsTime(departure).totalSeconds : -1;
    if (departure) maxStopTimeSeconds = Math.max(maxStopTimeSeconds, departureSeconds);
    const start = tripStarts[trip] ??= [Infinity, -1, 0], sequence = Number(row.field('stop_sequence'));
    if (sequence < start[0]) { start[0] = sequence; start[1] = departureSeconds; }
    if (departure) start[2]++;
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
  const skeleton = await compileSchedule({ coverage: source.coverage, feedId: source.feedId, files: filesFor(text, `${tripsHeader}\n`, `${stopTimesHeader}\n`),
    window: { startDate: start, endDate: end }, source: { url: source.url, retrievedAt: source.retrievedAt }, identity });
  const discovery: DiscoveryIndex = { ...skeleton.discovery, tripProviderIds: [...tripRoutes.keys()].sort(),
    stopRoutes: Object.fromEntries([...stopRoutes].map(([stop, routes]) => [stop, [...routes].sort()])) };
  const discoveryBytes = new TextEncoder().encode(canonicalJson(discovery)), discoveryHash = await sha256(discoveryBytes);
  return { identity, dates, sources: skeleton.manifest.sources, agencyTimezones: skeleton.manifest.agencyTimezones,
    discovery: { feedId: source.feedId, key: `artifacts/${source.coverage.id}/v2/${source.feedId}/discovery/${discoveryHash}.json`, sha256: discoveryHash, byteLength: discoveryBytes.length },
    discoveryBytes, stats: { trips: tripRoutes.size, stops: discovery.stops.length, routes: discovery.routes.length },
    stopTimes: { header: stopTimesHeader, size: stopTimes.size, tripRanges, tripStarts } };
}

/** One service date: stream stop_times keeping only that date's trips, then compile each
 * first-departure band separately. Output equals partitioning a whole-feed compile. */
/** How a date step reads stop_times when not from the archive itself: ranged reads of the
 * stored copy, or (`starts` + `bandRows`) the copy split by first-departure band. `text`
 * supplies the small tables so the archive need not be loaded at all. */
export interface StoredStopTimes {
  header: string; rows: (trips: ReadonlySet<string>) => AsyncIterable<StopTimeRow>;
  starts?: TripStarts; bandRows?: (band: number) => AsyncIterable<StopTimeRow>; text?: ArchiveText;
}

/** One dense feed's stored stop_times rows for one band: stream the copy once, keep the
 * rows of trips starting in that band. Memory holds only that band's text. */
export async function bandText(copy: ReadableStream<Uint8Array>, header: string, starts: TripStarts, bandSeconds: number, band: number): Promise<string> {
  const lines: string[] = [];
  for await (const row of stopTimeRecords(csvRecordSpans(copy), header)) {
    const start = starts[row.field('trip_id')];
    if (start && start[1] >= 0 && Math.floor(start[1] / bandSeconds) === band) lines.push(row.raw);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
/** Rows of a band object written by bandText. */
export function bandTextRows(text: string, header: string): AsyncIterable<StopTimeRow> {
  return stopTimeRecords(csvRecordSpans(new Blob([text]).stream()), header);
}
/** The bands a feed's trips start in (dense feeds are split into one object per band). */
export function startBands(starts: TripStarts, bandSeconds: number): number[] {
  return [...new Set(Object.values(starts).filter(start => start[1] >= 0 && start[2] >= 2).map(start => Math.floor(start[1] / bandSeconds)))].sort((a, b) => a - b);
}

export async function buildServiceDate(archive: Uint8Array | null, source: EdgeSource, identity: FeedIdentity, date: string, bandSeconds: number,
  ranged?: StoredStopTimes): Promise<DateBuild> {
  if (!archive && !ranged?.text) throw new Error('A date build needs the archive or its stored tables');
  const { stopTimes, text } = ranged?.text ? { stopTimes: null, text: ranged.text } : await open(archive!, source);
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
  if (ranged?.starts) return buildBands(source, identity, date, bandSeconds, text, tripsHeader!, tripRecords, { ...ranged, starts: ranged.starts });
  const active = new Map<string, { lines: string[]; firstSequence: number; firstDeparture: number | null; timed: number }>();
  let stopTimesHeader = '';
  const tripIds = new Set(tripRecords.keys());
  if (ranged) stopTimesHeader = ranged.header;
  const rows: AsyncIterable<StopTimeRow & { header?: true }> = ranged ? ranged.rows(tripIds) : stopTimeRows(archive!, stopTimes!);
  for await (const row of rows) {
    if (row.header) { stopTimesHeader = row.raw; continue; }
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

/** The scan's trip starts place every trip of the date in its band before any row is read;
 * each band's rows are then read, compiled and partitioned on their own. A dense bus day
 * (about 600,000 stop times) never sits in memory at once. Output is identical. */
async function buildBands(source: EdgeSource, identity: FeedIdentity, date: string, bandSeconds: number, text: ArchiveText,
  tripsHeader: string, tripRecords: Map<string, string>, ranged: StoredStopTimes & { starts: TripStarts }): Promise<DateBuild> {
  const bands = new Map<number, string[]>();
  let usable = 0;
  for (const trip of tripRecords.keys()) {
    const start = ranged.starts[trip];
    // Partitioning drops GTFS-unusable trips and trips without a first departure.
    if (!start || start[2] < 2 || start[1] < 0) continue;
    usable++;
    const band = Math.floor(start[1] / bandSeconds), list = bands.get(band) ?? []; list.push(trip); bands.set(band, list);
  }
  const result: DateBuild = { date, objects: [], descriptors: [], trips: usable };
  // A date with no usable service still publishes one object, so it reads as "no service".
  const parts = usable ? [...bands.keys()].sort((a, b) => a - b).map(band => bands.get(band)!) : [[]];
  for (const trips of parts) {
    const lines: string[] = [], wanted = new Set(trips);
    const band = trips.length ? Math.floor(ranged.starts[trips[0]!]![1] / bandSeconds) : -1;
    const rows = !trips.length ? [] : ranged.bandRows ? ranged.bandRows(band) : ranged.rows(wanted);
    for await (const row of rows) if (wanted.has(row.field('trip_id'))) lines.push(row.raw);
    const compiled = await compileSchedule({ coverage: source.coverage, feedId: source.feedId, identity,
      files: filesFor(text, [tripsHeader, ...trips.map(trip => tripRecords.get(trip)!)].join('\n') + '\n', [ranged.header, ...lines].join('\n') + '\n'),
      window: { startDate: date, endDate: date }, source: { url: source.url, retrievedAt: source.retrievedAt } });
    const partitioned = await partitionSchedule(compiled, bandSeconds);
    result.objects.push(...partitioned.objects.filter(object => !object.key.includes('/discovery/')));
    result.descriptors.push(...partitioned.manifest.shards);
  }
  return result;
}
