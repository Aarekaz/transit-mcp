import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { traced } from '../../../transit/trace';
import type { MetroMcpContext } from '../../context';
import { readOnlyLive } from '../../shared';
import { getScheduledDeparturePages, type ScheduledDeparture, type ScheduledDepartures } from '../../../transit/planner/departures';
import type { NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { formatEntityRef, parseTransitRef } from '../../../transit/core/refs';
import { DecodedShardCache } from '../../../transit/planner/schedule-index';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { stopAccess } from '../../../transit/accessibility/equipment';
import type { ScheduleTrip } from '../../../transit/gtfs/static/schema';
import { complete, MAX_DISCOVERY_CANDIDATES, closestStops, judgedAt, localTime, residentShards, TransitToolError, asTransitRef, boundedText, checkState, coverageSchema, guarded, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, complexStations, routeName, stopPlaces, ambiguousPlaces, describeCandidate, candidateSchema, stationAgencies, unavailable, validRef, type TransitData } from './shared';
import { getCoverage } from '../../../transit/core/coverage';

const departureShape = { tripRef: z.string(), serviceDate: z.string(), routeRef: z.string(), routeName: z.string().describe('Public route name, e.g. "1", "A" or "Red".'),
  agencyRef: z.string(), stopRef: z.string(), stopName: z.string(), stopSequence: z.number().int(),
  stepFree: z.enum(['accessible', 'not_accessible', 'unknown']).describe('Step-free access to this platform per the agency\'s station data; live elevator outages are in get_service_status.'),
  headsign: z.string(), directionId: z.number().int().nullable(), pickupType: z.number().int(), status: z.enum(['scheduled_only', 'realtime']), feedId: z.string(), scheduleVersion: z.string(), agencyTimezone: z.string() };
/** `matched` rows are calls of a canonical scheduled trip instance. Observed rows
 * (`unscheduled_call`: a reroute stop; `unmatched_trip`: a train absent from the
 * schedule) have only a prediction: no scheduled time or schedule stop sequence. */
const departureSchema = z.strictObject({ ...departureShape, stopSequence: z.number().int().nullable(), tripInstanceRef: z.string(), scheduledTime: instantSchema.nullable(),
  predictedTime: instantSchema.nullable(), platform: z.string().nullable(), scheduleMatch: z.enum(['matched', 'unscheduled_call', 'unmatched_trip']),
  arrival: z.strictObject({ stopRef: z.string(), stopName: z.string(), stopSequence: z.number().int(), scheduledTime: instantSchema.nullable(), predictedTime: instantSchema.nullable() }).nullable()
    .describe('With a destination: where and when this trip reaches it. Null without one.') });
const frequencySchema = z.strictObject({ ...departureShape, tripTemplateRef: z.string(), startTime: instantSchema, endTime: instantSchema, overlapStartTime: instantSchema, overlapEndTime: instantSchema,
  headwaySeconds: z.number().int(), exactTimes: z.literal(false) });
type Unnamed<T> = Omit<T, 'routeName' | 'stopName' | 'stepFree' | 'arrival'> & { arrival?: Omit<NonNullable<z.infer<typeof departureSchema>['arrival']>, 'stopName'> | null };

export function registerDeparturesTool(server: McpServer, context: MetroMcpContext): void {
  server.registerTool('get_departures', {
    title: 'Departures at a stop', description: 'Find what leaves a stop next, the first service or last service in a bounded window. Pass a stopRef from find_transit, or a stop name with its coverage: a name for one place covers all its stations in that network (otherStations lists the same place in other networks, such as the LIRR at Penn Station); a name for different places returns a question to ask, with candidates. A station covers its whole complex, e.g. every line at Times Sq-42 St; a platform ref covers that platform. Pass toStop or toStopRef for the next trips from here that stop at a destination, each with its arrival time there. Returns dated trip references for get_vehicle_status. For a journey with a change use plan_trip (with routes where needed): departures alone cannot prove a connection.',
    annotations: readOnlyLive('Departures at a stop'),
    inputSchema: z.strictObject({ stopRef: boundedText.optional().describe('Exact stop or station reference. Give this or stop.'),
      stop: boundedText.optional().describe('Stop or station name, with coverage. Give this or stopRef.'), coverage: coverageSchema.optional(), at: instantSchema.optional(), windowSeconds: z.number().int().default(7200).describe('Search window in seconds, 1 through 604800 (seven days).'),
      toStopRef: boundedText.optional().describe('Destination stop or station: only trips that go on to stop there are listed, each with its arrival time there.'),
      toStop: boundedText.optional().describe('Destination stop or station name, with coverage. Give this or toStopRef, or neither.'),
      routeRefs: z.array(boundedText).max(20).optional(), agencyRefs: z.array(boundedText).max(20).optional(), selection: z.enum(['first', 'last']).default('first'), limit: z.number().int().min(1).max(100).default(20) }),
    outputSchema: z.strictObject({ ...resultShape, departures: z.array(departureSchema), frequencyWindows: z.array(frequencySchema),
      otherStations: z.array(candidateSchema).optional().describe('The same place in another network (the LIRR at Penn Station): call again with its ref for its departures.') }),
  }, async (args, handler) => guarded(handler, () => traced('get_departures', async () => {
    checkState(handler);
    if (args.windowSeconds < 1 || args.windowSeconds > 604800) throw new TransitToolError('TIME_OUTSIDE_WINDOW');
    if (!args.stopRef === !args.stop || args.toStopRef && args.toStop) throw new TransitToolError('INVALID_TRANSIT_REF');
    let stopRef = args.stopRef, data: TransitData | null = null, members: string[] = [];
    if (args.stop) {
      // One request for the common question: resolve the name exactly as plan_trip does.
      const coverageId = getCoverage(args.coverage ?? '')?.id;
      if (!coverageId) throw new TransitToolError('ENTITY_NOT_FOUND');
      data = await loadData(context, coverageId, handler.mcpReq.signal);
      if (!data) return complete({ ...unavailable(coverageId), departures: [], frequencyWindows: [] });
      const places = stopPlaces(data, args.stop);
      if (!places.length) throw new TransitToolError('ENTITY_NOT_FOUND', closestStops(data, args.stop));
      if (places.length > MAX_DISCOVERY_CANDIDATES) return complete({ ...unavailable(coverageId, data, ['SCOPE_LIMIT_EXCEEDED']), departures: [], frequencyWindows: [] });
      if (places.length > 1) throw ambiguousPlaces(args.stop, places);
      stopRef = places[0]!.candidate.ref; members = places[0]!.members;
    }
    const stop = validRef(stopRef!, ['stop']);
    for (const ref of args.routeRefs ?? []) validRef(ref, ['route']);
    for (const ref of args.agencyRefs ?? []) validRef(ref, ['agency']);
    data ??= await loadData(context, stop.coverage, handler.mcpReq.signal);
    if (!data) return complete({ ...unavailable(stop.coverage), departures: [], frequencyWindows: [] });
    knownEntity(data, stopRef!);
    for (const ref of [...args.routeRefs ?? [], ...args.agencyRefs ?? []]) knownEntity(data, ref);
    const now = new Date().toISOString(), nowSeconds = Date.parse(now) / 1000;
    // A destination keeps only trips that stop there later: "the next train from A to B".
    let toRef = args.toStopRef, toMembers: string[] = [];
    if (args.toStop) {
      const places = stopPlaces(data, args.toStop);
      if (!places.length) throw new TransitToolError('ENTITY_NOT_FOUND', closestStops(data, args.toStop));
      if (places.length > MAX_DISCOVERY_CANDIDATES) return complete({ ...unavailable(stop.coverage, data, ['SCOPE_LIMIT_EXCEEDED']), departures: [], frequencyWindows: [] });
      if (places.length > 1) throw ambiguousPlaces(args.toStop, places);
      toRef = places[0]!.candidate.ref; toMembers = places[0]!.members;
    }
    if (toRef && validRef(toRef, ['stop']).coverage !== stop.coverage) throw new TransitToolError('INVALID_TRANSIT_REF');
    if (toRef) knownEntity(data, toRef);
    const toWithin = toRef ? new Set([toRef, ...complexStations(data, toRef), ...toMembers]) : undefined;
    const destinationStops = new Set(toWithin ? data.indexes.flatMap(index => index.stops).filter(row => toWithin.has(row.ref) || row.parentStationRef !== undefined && toWithin.has(row.parentStationRef)).map(row => row.ref as string) : []);
    // A station is the whole complex a rider knows by that name; a platform is just itself. A
    // named place adds its other stations in this network; those in others are listed.
    const complex = [...new Set([...complexStations(data, stopRef!), ...members.filter(ref => ref !== stopRef && parseTransitRef(ref)!.feed === stop.feed)])], within = new Set([stopRef!, ...complex]);
    const otherStations = members.filter(ref => parseTransitRef(ref)!.feed !== stop.feed).map(ref => describeCandidate(data!, knownEntity(data!, ref)));
    const relevantStops = new Set(data.indexes.flatMap(index => index.stops).filter(stop => within.has(stop.ref) || stop.parentStationRef !== undefined && within.has(stop.parentStationRef)).map(stop => stop.ref));
    // One decode per shard: the scan fills this, and observed rows read trips from it.
    const decoded = new DecodedShardCache(Number.MAX_SAFE_INTEGER);
    const pages = getScheduledDeparturePages({ manifest: data.manifest, readShard: data.readObject, decoded, resident: residentShards, readDiscovery: data.readObject, stopRef: asTransitRef(stopRef!), complexStationRefs: complex.map(asTransitRef),
      instant: args.at ?? now, windowSeconds: args.windowSeconds, selection: args.selection, limit: 100, routeRefs: args.routeRefs?.map(asTransitRef), agencyRefs: stationAgencies(data, relevantStops, args.agencyRefs) });
    const scheduled: ScheduledDeparture[] = []; let schedule: ScheduledDepartures | undefined;
    // Predictions can reorder any scheduled page. Exhaust the bounded window before ranking.
    for await (const page of pages) { handler.mcpReq.signal.throwIfAborted(); schedule = page; scheduled.push(...page.departures); }
    if (!schedule) throw new Error('Missing departure scan');
    const trips = new Map<string, Pick<ScheduleTrip, 'headsign' | 'directionId' | 'routeRef' | 'stopTimes'>>();
    for (const shard of decoded.shards()) for (const trip of shard.trips) {
      const stopTimes = trip.stopTimes.filter(call => relevantStops.has(call.stopRef) || destinationStops.has(call.stopRef));
      if (stopTimes.length) trips.set(trip.ref, { headsign: trip.headsign, directionId: trip.directionId, routeRef: trip.routeRef, stopTimes });
    }
    const stopIndex = data.indexes.flatMap(index => index.stops);
    const relevantProviderIds = stopIndex.filter(stop => relevantStops.has(stop.ref) || destinationStops.has(stop.ref)).map(stop => stop.providerId);
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
    const judged = judgedAt(nowSeconds, feed.producerTimestampSeconds);
    const fresh = feed?.status === 'realtime' && feed.producerTimestampSeconds !== undefined && judged >= feed.producerTimestampSeconds && judged - feed.producerTimestampSeconds <= data.coverage.thresholds.tripUpdates.realtimeSeconds;
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
    if (toWithin) {
      // A trip qualifies only if it calls at the destination after boarding and lets riders
      // off there; a prediction that skips that stop removes it. Observed-only rows cannot
      // be proven to reach it, so they are left out.
      departures = departures.flatMap(row => {
        const trip = trips.get(row.tripRef), board = trip?.stopTimes.find(call => call.sequence === row.stopSequence);
        const call = row.stopSequence === null ? undefined : trip?.stopTimes.find(call => call.sequence > row.stopSequence! && destinationStops.has(call.stopRef) && call.dropOffType !== 1);
        if (!trip || !board || !call || row.scheduledTime === null) return [];
        const update = fresh ? feed.payload?.find(update => update.tripInstanceRef === row.tripInstanceRef && update.stopSequence === call.sequence && update.stopId === parseTransitRef(call.stopRef)!.id) : undefined;
        if (update?.status === 'canceled' || update?.status === 'skipped') return [];
        const scheduledAt = call.arrivalSeconds ?? call.departureSeconds, boardAt = board.departureSeconds ?? board.arrivalSeconds;
        const predicted = update?.status === 'realtime' ? update.arrivalTimeSeconds ?? update.departureTimeSeconds : undefined;
        return [{ ...row, arrival: { stopRef: call.stopRef, stopSequence: call.sequence,
          scheduledTime: scheduledAt === null || boardAt === null ? null : new Date(Date.parse(row.scheduledTime) + (scheduledAt - boardAt) * 1000).toISOString(),
          predictedTime: predicted === undefined ? null : new Date(predicted * 1000).toISOString() } }];
      });
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
    // Riders know where they get off by the station's name, not the platform's.
    const arrivalStation = (ref: string) => { const row = allStops.get(ref), parent = row?.parentStationRef ? allStops.get(row.parentStationRef) : undefined; return sanitizeTransitText(parent?.name ?? row?.name ?? '', 200); };
    const withArrival = (row: Unnamed<z.infer<typeof departureSchema>>) => ({ ...named(row), scheduledTime: localTime(row.scheduledTime, row.agencyTimezone), predictedTime: localTime(row.predictedTime, row.agencyTimezone),
      arrival: row.arrival ? { ...row.arrival, scheduledTime: localTime(row.arrival.scheduledTime, row.agencyTimezone), predictedTime: localTime(row.arrival.predictedTime, row.agencyTimezone), stopName: arrivalStation(row.arrival.stopRef) } : null });
    // Frequency templates have no instance times; keep those that serve the destination later.
    const windows = toWithin ? schedule.frequencyWindows.filter(window => trips.get(window.tripRef)?.stopTimes.some(call => call.sequence > window.stopSequence && destinationStops.has(call.stopRef) && call.dropOffType !== 1)) : schedule.frequencyWindows;
    return complete({ ...meta, sources,
      status: departures.some(row => row.status === 'realtime') ? 'realtime' as const : schedule.status, reasons: [...new Set([...schedule.reasons, ...feed.reasons])],
      departures: departures.map(withArrival), frequencyWindows: windows.map(named), ...(otherStations.length ? { otherStations } : {}) });
  }), () => complete({ ...unavailable(args.stopRef ? parseTransitRef(args.stopRef)?.coverage : getCoverage(args.coverage ?? '')?.id), departures: [], frequencyWindows: [] })));
}
