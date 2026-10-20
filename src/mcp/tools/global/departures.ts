import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getScheduledDeparturePages, type ScheduledDeparture, type ScheduledDepartures } from '../../../transit/planner/departures';
import type { NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { formatEntityRef, parseTransitRef } from '../../../transit/core/refs';
import { DecodedShardCache } from '../../../transit/planner/schedule-index';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { stopAccess } from '../../../transit/accessibility/equipment';
import type { ScheduleTrip } from '../../../transit/gtfs/static/schema';
import { MAX_DISCOVERY_CANDIDATES, TransitToolError, asTransitRef, boundedText, candidates, checkState, coverageSchema, guarded, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, complexStations, routeName, sameStation, unavailable, validRef, type TransitData } from './shared';
import { getCoverage } from '../../../transit/core/coverage';

const departureShape = { tripRef: z.string(), serviceDate: z.string(), routeRef: z.string(), routeName: z.string().describe('Public route name, e.g. "1", "A" or "Red".'),
  agencyRef: z.string(), stopRef: z.string(), stopName: z.string(), stopSequence: z.number().int(),
  stepFree: z.enum(['accessible', 'not_accessible', 'unknown']).describe('Step-free access to this platform per the agency\'s station data; live elevator outages are in get_service_status.'),
  headsign: z.string(), directionId: z.number().int().nullable(), pickupType: z.number().int(), status: z.enum(['scheduled_only', 'realtime']), feedId: z.string(), scheduleVersion: z.string(), agencyTimezone: z.string() };
/** `matched` rows are calls of a canonical scheduled trip instance. Observed rows
 * (`unscheduled_call`: a reroute stop; `unmatched_trip`: a train absent from the
 * schedule) have only a prediction: no scheduled time or schedule stop sequence. */
const departureSchema = z.strictObject({ ...departureShape, stopSequence: z.number().int().nullable(), tripInstanceRef: z.string(), scheduledTime: instantSchema.nullable(),
  predictedTime: instantSchema.nullable(), platform: z.string().nullable(), scheduleMatch: z.enum(['matched', 'unscheduled_call', 'unmatched_trip']) });
const frequencySchema = z.strictObject({ ...departureShape, tripTemplateRef: z.string(), startTime: instantSchema, endTime: instantSchema, overlapStartTime: instantSchema, overlapEndTime: instantSchema,
  headwaySeconds: z.number().int(), exactTimes: z.literal(false) });
type Unnamed<T> = Omit<T, 'routeName' | 'stopName' | 'stepFree'>;

export function registerDeparturesTool(server: McpServer, context: MetroMcpContext): void {
  server.registerTool('get_departures', {
    title: 'Departures at a stop', description: 'Find what leaves a stop next, the first service or last service in a bounded window. Pass a stopRef from find_transit, or a stop name with its coverage (one station complex resolves directly; different same-named stations return candidates). A station covers its whole complex, e.g. every line at Times Sq-42 St; a platform ref covers that platform. Returns dated trip references for get_vehicle_status. Use plan_trip for journeys; departures cannot establish a route or connection.',
    annotations: readOnlyLive('Departures at a stop'),
    inputSchema: z.strictObject({ stopRef: boundedText.optional().describe('Exact stop or station reference. Give this or stop.'),
      stop: boundedText.optional().describe('Stop or station name, with coverage. Give this or stopRef.'), coverage: coverageSchema.optional(), at: instantSchema.optional(), windowSeconds: z.number().int().default(7200).describe('Search window in seconds, 1 through 604800 (seven days).'),
      routeRefs: z.array(boundedText).max(20).optional(), agencyRefs: z.array(boundedText).max(20).optional(), selection: z.enum(['first', 'last']).default('first'), limit: z.number().int().min(1).max(100).default(20) }),
    outputSchema: z.strictObject({ ...resultShape, departures: z.array(departureSchema), frequencyWindows: z.array(frequencySchema) }),
  }, async (args, handler) => guarded(handler, async () => {
    checkState(handler, 'get_departures');
    if (args.windowSeconds < 1 || args.windowSeconds > 604800) throw new TransitToolError('TIME_OUTSIDE_WINDOW');
    if (!args.stopRef === !args.stop) throw new TransitToolError('INVALID_TRANSIT_REF');
    let stopRef = args.stopRef, data: TransitData | null = null;
    if (args.stop) {
      // One request for the common question: resolve the name exactly as plan_trip does.
      const coverageId = getCoverage(args.coverage ?? '')?.id;
      if (!coverageId) throw new TransitToolError('ENTITY_NOT_FOUND');
      data = await loadData(context, coverageId, handler.mcpReq.signal);
      if (!data) return complete({ ...unavailable(coverageId), departures: [], frequencyWindows: [] });
      const matches = sameStation(data, candidates(data, args.stop, 'stop'));
      if (!matches.length) throw new TransitToolError('ENTITY_NOT_FOUND');
      if (matches.length > MAX_DISCOVERY_CANDIDATES) return complete({ ...unavailable(coverageId, data, ['SCOPE_LIMIT_EXCEEDED']), departures: [], frequencyWindows: [] });
      if (matches.length > 1) throw new TransitToolError('ENTITY_AMBIGUOUS', matches);
      stopRef = matches[0]!.ref;
    }
    const stop = validRef(stopRef!, ['stop']);
    for (const ref of args.routeRefs ?? []) validRef(ref, ['route']);
    for (const ref of args.agencyRefs ?? []) validRef(ref, ['agency']);
    data ??= await loadData(context, stop.coverage, handler.mcpReq.signal);
    if (!data) return complete({ ...unavailable(stop.coverage), departures: [], frequencyWindows: [] });
    knownEntity(data, stopRef!);
    for (const ref of [...args.routeRefs ?? [], ...args.agencyRefs ?? []]) knownEntity(data, ref);
    const now = new Date().toISOString(), nowSeconds = Date.parse(now) / 1000;
    // A station is the whole complex a rider knows by that name; a platform is just itself.
    const complex = complexStations(data, stopRef!), within = new Set([stopRef!, ...complex]);
    const relevantStops = new Set(data.indexes.flatMap(index => index.stops).filter(stop => within.has(stop.ref) || stop.parentStationRef !== undefined && within.has(stop.parentStationRef)).map(stop => stop.ref));
    // One decode per shard: the scan fills this, and observed rows read trips from it.
    const decoded = new DecodedShardCache(Number.MAX_SAFE_INTEGER);
    const pages = getScheduledDeparturePages({ manifest: data.manifest, readShard: data.readObject, decoded, readDiscovery: data.readObject, stopRef: asTransitRef(stopRef!), complexStationRefs: complex.map(asTransitRef),
      instant: args.at ?? now, windowSeconds: args.windowSeconds, selection: args.selection, limit: 100, routeRefs: args.routeRefs?.map(asTransitRef), agencyRefs: args.agencyRefs?.map(asTransitRef) });
    const scheduled: ScheduledDeparture[] = []; let schedule: ScheduledDepartures | undefined;
    // Predictions can reorder any scheduled page. Exhaust the bounded window before ranking.
    for await (const page of pages) { handler.mcpReq.signal.throwIfAborted(); schedule = page; scheduled.push(...page.departures); }
    if (!schedule) throw new Error('Missing departure scan');
    const trips = new Map<string, Pick<ScheduleTrip, 'headsign' | 'directionId' | 'routeRef' | 'stopTimes'>>();
    for (const shard of decoded.shards()) for (const trip of shard.trips) {
      const stopTimes = trip.stopTimes.filter(call => relevantStops.has(call.stopRef));
      if (stopTimes.length) trips.set(trip.ref, { headsign: trip.headsign, directionId: trip.directionId, routeRef: trip.routeRef, stopTimes });
    }
    const stopIndex = data.indexes.flatMap(index => index.stops);
    const relevantProviderIds = stopIndex.filter(stop => relevantStops.has(stop.ref)).map(stop => stop.providerId);
    // Provider stop IDs repeat across feeds (LIRR 101 is not subway 101): read this stop's feed only.
    const feed = await readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', nowSeconds, handler.mcpReq.signal, relevantProviderIds, [stop.feed]);
    const meta = metadata(stop.coverage, data, now);
    const sources = [...meta.sources, ...realtimeSource(data, feed, 'trip_updates', nowSeconds)];
    // Duplicated and replacement service rewrite canonical calls in ways this board
    // cannot yet prove: refuse it rather than hide service or resurrect replaced calls.
    // ADDED trains are shown as observed rows (scheduleMatch: unmatched_trip).
    if (feed.payload?.some(update => ['DUPLICATED', 'REPLACEMENT'].includes(update.scheduleRelationship ?? ''))) {
      return complete({ ...meta, sources, status: 'unavailable' as const, reasons: ['REALTIME_UNAVAILABLE' as const], departures: [], frequencyWindows: [] });
    }
    const fresh = feed?.status === 'realtime' && feed.producerTimestampSeconds !== undefined && nowSeconds >= feed.producerTimestampSeconds && nowSeconds - feed.producerTimestampSeconds <= data.coverage.thresholds.tripUpdates.realtimeSeconds;
    let departures: Unnamed<z.infer<typeof departureSchema>>[] = scheduled.flatMap(departure => {
      const update = fresh ? feed.payload?.find(update => update.tripInstanceRef === departure.tripInstanceRef && update.stopSequence === departure.stopSequence && update.stopId === parseTransitRef(departure.stopRef)!.id) : undefined;
      if (update?.status === 'canceled' || update?.status === 'skipped') return [];
      const prediction = update?.status === 'realtime' ? update.departureTimeSeconds ?? update.arrivalTimeSeconds : undefined;
      return [{ ...departure, predictedTime: prediction === undefined ? null : new Date(prediction * 1000).toISOString(), platform: update?.track ?? null,
        status: prediction === undefined ? 'scheduled_only' as const : 'realtime' as const, scheduleMatch: 'matched' as const }];
    });
    const routesByProvider = new Map(data.indexes.find(index => index.feedId === stop.feed)?.routes.map(route => [route.providerId, route]) ?? []);
    const stopsByProvider = new Map(stopIndex.filter(row => parseTransitRef(row.ref)?.feed === stop.feed).map(row => [row.providerId, row]));
    const stationName = (providerId: string | undefined) => {
      const row = providerId === undefined ? undefined : stopsByProvider.get(providerId);
      const parent = row?.parentStationRef ? stopIndex.find(candidate => candidate.ref === row.parentStationRef) : undefined;
      return sanitizeTransitText(parent?.name ?? row?.name ?? '');
    };
    for (const update of fresh ? feed.payload ?? [] : []) {
      // Observed service the schedule cannot express. Keep it rather than hide a train.
      if (update.status !== 'realtime' || (update.scheduleMatch !== 'unscheduled_call' && update.scheduleMatch !== 'unmatched_trip') || !update.tripInstanceRef) continue;
      const instance = parseTransitRef(update.tripInstanceRef), route = update.routeId === undefined ? undefined : routesByProvider.get(update.routeId);
      const at = stopsByProvider.get(update.stopId), predicted = update.departureTimeSeconds ?? update.arrivalTimeSeconds;
      if (!instance || instance.kind !== 'trip' || !('serviceDate' in instance) || !route || !at || !relevantStops.has(at.ref) || predicted === undefined) continue;
      if (args.routeRefs && !args.routeRefs.includes(route.ref) || args.agencyRefs && !args.agencyRefs.includes(route.agencyRef)) continue;
      departures.push({ tripRef: formatEntityRef(instance), tripInstanceRef: update.tripInstanceRef, serviceDate: instance.serviceDate, routeRef: route.ref, agencyRef: route.agencyRef,
        stopRef: at.ref, stopSequence: null, headsign: stationName(update.destinationStopId), directionId: null, pickupType: 0,
        scheduledTime: null, predictedTime: new Date(predicted * 1000).toISOString(), platform: update.track ?? null, status: 'realtime', scheduleMatch: update.scheduleMatch,
        feedId: instance.feed, scheduleVersion: data.version.sourceVersions[instance.feed]!, agencyTimezone: data.manifest.agencyTimezones[route.agencyRef]! });
    }
    for (const update of fresh ? feed.payload ?? [] : []) {
      if (!update.tripInstanceRef || update.status !== 'realtime' || update.scheduleMatch && update.scheduleMatch !== 'matched' || departures.some(row => row.tripInstanceRef === update.tripInstanceRef && row.stopSequence === update.stopSequence)) continue;
      const instance = parseTransitRef(update.tripInstanceRef);
      if (!instance || instance.kind !== 'trip' || !('serviceDate' in instance)) continue;
      const tripRef = formatEntityRef(instance), trip = trips.get(tripRef);
      const call = trip?.stopTimes.find(call => call.sequence === update.stopSequence && parseTransitRef(call.stopRef)?.id === update.stopId && call.pickupType !== 1);
      const route = data.indexes.flatMap(index => index.routes).find(route => route.ref === trip?.routeRef);
      const predicted = update.departureTimeSeconds ?? update.arrivalTimeSeconds, scheduled = update.scheduledDepartureTimeSeconds ?? update.scheduledArrivalTimeSeconds;
      if (!trip || !call || !route || predicted === undefined || scheduled === undefined || args.routeRefs && !args.routeRefs.includes(route.ref) || args.agencyRefs && !args.agencyRefs.includes(route.agencyRef)) continue;
      departures.push({ tripRef, tripInstanceRef: update.tripInstanceRef, serviceDate: instance.serviceDate, routeRef: route.ref, agencyRef: route.agencyRef,
        stopRef: call.stopRef, stopSequence: call.sequence, headsign: call.headsign || trip.headsign, directionId: trip.directionId, pickupType: call.pickupType,
        scheduledTime: new Date(scheduled * 1000).toISOString(), predictedTime: new Date(predicted * 1000).toISOString(), platform: update.track ?? null, status: 'realtime', scheduleMatch: 'matched',
        feedId: instance.feed, scheduleVersion: data.version.sourceVersions[instance.feed]!, agencyTimezone: data.manifest.agencyTimezones[route.agencyRef]! });
    }
    const start = Date.parse(args.at ?? now), end = start + args.windowSeconds * 1000, direction = args.selection === 'last' ? -1 : 1;
    const time = (row: Unnamed<z.infer<typeof departureSchema>>) => Date.parse(row.predictedTime ?? row.scheduledTime!);
    departures = departures.filter(row => time(row) >= start && time(row) < end).sort((a, b) => direction * (time(a) - time(b)) || a.tripInstanceRef.localeCompare(b.tripInstanceRef) ||
      (a.stopSequence ?? -1) - (b.stopSequence ?? -1) || a.stopRef.localeCompare(b.stopRef)).slice(0, args.limit);
    // Human-readable names beside the opaque references, so a model can answer directly.
    const routeNames = new Map(data.indexes.flatMap(index => index.routes).map(route => [route.ref as string, routeName(route)]));
    const stopNames = new Map(data.indexes.flatMap(index => index.stops).map(row => [row.ref as string, sanitizeTransitText(row.name, 200)]));
    const stopRows = new Map(data.indexes.flatMap(index => index.stops.map(row => [row.ref as string, { index, row }] as const)));
    const allStops = new Map([...stopRows].map(([ref, { row }]) => [ref, row]));
    const access = (ref: string) => { const found = stopRows.get(ref); return found ? stopAccess(found.index, found.row, allStops) : 'unknown' as const; };
    const named = <T extends { routeRef: string; stopRef: string }>(row: T) => ({ ...row, routeName: routeNames.get(row.routeRef) ?? '', stopName: stopNames.get(row.stopRef) ?? '', stepFree: access(row.stopRef) });
    return complete({ ...meta, sources,
      status: departures.some(row => row.status === 'realtime') ? 'realtime' as const : schedule.status, reasons: [...new Set([...schedule.reasons, ...feed.reasons])],
      departures: departures.map(named), frequencyWindows: schedule.frequencyWindows.map(named) });
  }, () => complete({ ...unavailable(args.stopRef ? parseTransitRef(args.stopRef)?.coverage : getCoverage(args.coverage ?? '')?.id), departures: [], frequencyWindows: [] })));
}
