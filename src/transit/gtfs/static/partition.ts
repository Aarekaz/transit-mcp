import { isServiceActive } from '../../planner/service-day';
import { parseServiceDate } from './time';
import { encodeScheduleShard, sha256 } from './shards';
import type { TransitRef } from '../../core/refs';
import type { ArtifactManifestV2, CompiledSchedule, ScheduleShard, ShardTimeRange } from './schema';

export interface PartitionedSchedule {
  manifest: ArtifactManifestV2;
  objects: { key: string; bytes: Uint8Array }[];
  shards: ScheduleShard[];
}

function dates(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  const end = parseServiceDate(endDate).getTime();
  for (let date = parseServiceDate(startDate); date.getTime() <= end; date = new Date(date.getTime() + 86_400_000)) {
    result.push(date.toISOString().slice(0, 10).replaceAll('-', ''));
  }
  return result;
}

/** Splits one compiled window into per-service-date, first-departure time bands so a
 * query decodes only the timetable it can use. Offline only. Trip transfers and headway
 * templates are refused rather than cut, because a band boundary would silently drop
 * them. Blocks need no table: the planner and validator read a continuation from each
 * trip's blockId among the trips a query loads, and every band overlapping a query's
 * window is loaded, so the trips between two loaded trips of one block are loaded too.
 * A band therefore publishes an empty block table. */
export interface PartitionOptions {
  /** Split each band by agency so a query decodes only the agencies it can use (see
   * agencyGrouping). Each group carries only the stops, walkways and transfers its own
   * trips reach. */
  agencyGroups?: number;
}

/** Modes of agencies that form a region's backbone: every journey may use them. */
export const BACKBONE_MODES: ReadonlySet<string> = new Set(['rail', 'subway', 'ferry']);
/** Agencies ordered into at most `count` groups: the backbone (agencies running only rail,
 * subway or ferry) together, since every journey loads it; then the busiest other agencies
 * alone; the rest share the last group. */
export function agencyGrouping(shard: ScheduleShard, count: number): TransitRef[][] {
  const trips = new Map<TransitRef, number>(), modes = new Map<TransitRef, Set<string>>();
  for (const agency of Object.keys(shard.agencyTimezones) as TransitRef[]) { trips.set(agency, 0); modes.set(agency, new Set()); }
  const routes = new Map(shard.routes.map(route => [route.ref, route]));
  for (const route of shard.routes) modes.get(route.agencyRef)?.add(route.mode);
  for (const trip of shard.trips) { const agency = routes.get(trip.routeRef)!.agencyRef; trips.set(agency, (trips.get(agency) ?? 0) + 1); }
  const backbone = [...modes].filter(([, set]) => set.size > 0 && [...set].every(mode => BACKBONE_MODES.has(mode))).map(([agency]) => agency).sort();
  const others = [...trips].filter(([agency]) => !backbone.includes(agency)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([agency]) => agency);
  const groups: TransitRef[][] = backbone.length ? [backbone] : [];
  const alone = Math.max(0, count - groups.length - 1);
  if (others.length <= alone + 1) return [...groups, ...others.map(agency => [agency])];
  return [...groups, ...others.slice(0, alone).map(agency => [agency]), others.slice(alone).sort()];
}

/** The part of a feed one agency group's band can touch: its routes, the stops its trips
 * call at with their stations' other stops, and walkways and transfers wholly inside. */
function groupScope(shard: ScheduleShard, agencies: ReadonlySet<TransitRef>, trips: readonly ScheduleShard['trips'][number][]): Pick<ScheduleShard, 'stops' | 'routes' | 'transfers' | 'pathways'> {
  const routes = shard.routes.filter(route => agencies.has(route.agencyRef)), routeRefs = new Set(routes.map(route => route.ref));
  const byRef = new Map(shard.stops.map(stop => [stop.ref, stop]));
  const used = new Set<TransitRef>();
  for (const trip of trips) for (const call of trip.stopTimes) used.add(call.stopRef);
  const stations = new Set<TransitRef>();
  for (const ref of used) { const parent = byRef.get(ref)?.parentStationRef; if (parent) stations.add(parent); }
  const stops = shard.stops.filter(stop => used.has(stop.ref) || stations.has(stop.ref) || stop.parentStationRef !== undefined && stations.has(stop.parentStationRef));
  const kept = new Set(stops.map(stop => stop.ref));
  return { stops, routes,
    pathways: shard.pathways.filter(pathway => kept.has(pathway.fromStopRef) && kept.has(pathway.toStopRef)),
    transfers: shard.transfers.filter(transfer => (!transfer.fromStopRef || kept.has(transfer.fromStopRef)) && (!transfer.toStopRef || kept.has(transfer.toStopRef)) &&
      (!transfer.fromRouteRef || routeRefs.has(transfer.fromRouteRef)) && (!transfer.toRouteRef || routeRefs.has(transfer.toRouteRef))) };
}

export async function partitionSchedule(compiled: CompiledSchedule, bandSeconds: number, options: PartitionOptions = {}): Promise<PartitionedSchedule> {
  const { shard } = compiled;
  if (!Number.isInteger(bandSeconds) || bandSeconds < 3600 || bandSeconds > 86_400) throw new Error('Invalid time band (1-24 hours)');
  if (shard.frequencies.length) throw new Error('Time bands do not support frequency-based trips');
  if (shard.transferBoundaryTrips.length || shard.transfers.some(transfer => transfer.fromTripRef || transfer.toTripRef)) {
    throw new Error('Time bands do not support trip-specific transfers');
  }
  const bandCount = Math.floor(shard.maxStopTimeSeconds / bandSeconds) + 1;
  const routeAgency = new Map(shard.routes.map(route => [route.ref, route.agencyRef]));
  if (options.agencyGroups !== undefined && (!Number.isInteger(options.agencyGroups) || options.agencyGroups < 2)) throw new Error('Invalid agency grouping');
  // Ungrouped: one undefined group keeps the whole-feed bands.
  const groups: ({ refs: TransitRef[]; agencies: ReadonlySet<TransitRef> } | undefined)[] = options.agencyGroups
    ? agencyGrouping(shard, options.agencyGroups).map(refs => ({ refs, agencies: new Set(refs) }))
    : [undefined];
  const prefix = `artifacts/${shard.coverageId}/v2/${shard.feedId}`;
  const objects: PartitionedSchedule['objects'] = [];
  const shards: ScheduleShard[] = [];
  const descriptors: ArtifactManifestV2['shards'] = [];
  for (const date of dates(shard.window.startDate, shard.window.endDate)) {
    // GTFS: a trip visiting fewer than two stops is unusable by passengers (validator
    // notice unusable_trip). Never publish one as service.
    const active = shard.trips.filter(trip => isServiceActive(shard.calendars[trip.serviceId]!, date) &&
      trip.stopTimes.filter(call => call.departureSeconds !== null).length >= 2);
    for (let band = 0; band < bandCount; band++) for (const [groupIndex, group] of groups.entries()) {
      const bandStart = band * bandSeconds, bandEnd = bandStart + bandSeconds;
      const trips = active.filter(trip => {
        const first = trip.stopTimes[0]!.departureSeconds;
        return first !== null && first >= bandStart && first < bandEnd && (!group || group.agencies.has(routeAgency.get(trip.routeRef)!));
      });
      // An empty date still needs one object so the date reads as "no service",
      // never as an expired schedule.
      if (!trips.length && (band > 0 || groupIndex > 0 || active.length)) continue;
      const calls = trips.flatMap(trip => trip.stopTimes.flatMap(call => [call.arrivalSeconds, call.departureSeconds]))
        .filter((value): value is number => value !== null);
      const firsts = trips.map(trip => trip.stopTimes[0]!.departureSeconds!);
      const timeRange: ShardTimeRange = { bandStart, bandEnd,
        start: firsts.length ? Math.min(...firsts) : bandStart, end: calls.length ? Math.max(...calls) : bandStart };
      const patternIds = new Set(trips.map(trip => trip.patternId)), serviceIds = new Set(trips.map(trip => trip.serviceId));
      const patterns = shard.patterns.filter(pattern => patternIds.has(pattern.id));
      // A band carries only the stops its trips serve (with their stations), and every stop a
      // transfer or pathway names: 7,540 Metrobus stops would otherwise be most of each band.
      const used = new Set<string>([...patterns.flatMap(pattern => pattern.stopRefs), ...shard.pathways.flatMap(pathway => [pathway.fromStopRef, pathway.toStopRef]),
        ...shard.transfers.flatMap(transfer => [transfer.fromStopRef, transfer.toStopRef].filter((ref): ref is NonNullable<typeof ref> => ref !== undefined))]);
      // Boarding area -> platform -> station: close over parents until nothing is added.
      for (let size = -1; size !== used.size;) { size = used.size; for (const stop of shard.stops) if (used.has(stop.ref) && stop.parentStationRef) used.add(stop.parentStationRef); }
      const part: ScheduleShard = { ...shard, window: { startDate: date, endDate: date }, timeRange, trips, blocks: {}, patterns,
        stops: shard.stops.filter(stop => used.has(stop.ref)),
        calendars: Object.fromEntries(Object.entries(shard.calendars).filter(([id]) => serviceIds.has(id))),
        ...group && groupScope(shard, group.agencies, trips) };
      const bytes = encodeScheduleShard(part), hash = await sha256(bytes);
      const key = `${prefix}/${date}/${String(bandStart).padStart(6, '0')}/${hash}.bin`;
      objects.push({ key, bytes });
      shards.push(part);
      descriptors.push({ feedId: shard.feedId, window: part.window, maxStopTimeSeconds: shard.maxStopTimeSeconds, timeRange, key, sha256: hash, byteLength: bytes.length,
        ...(group ? { agencyRefs: group.refs } : {}) });
    }
  }
  objects.push({ key: compiled.manifest.discoveries[0]!.key, bytes: compiled.discoveryBytes });
  if (compiled.manifest.places?.[0]) objects.push({ key: compiled.manifest.places[0].key, bytes: compiled.placesBytes });
  return { manifest: { ...compiled.manifest, shards: descriptors }, objects, shards };
}
