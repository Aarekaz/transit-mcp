import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getScheduledDeparturePages, type ScheduledDeparture, type ScheduledDepartures } from '../../../transit/planner/departures';
import type { NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { formatEntityRef, parseTransitRef } from '../../../transit/core/refs';
import { decodeScheduleShard } from '../../../transit/gtfs/static/shards';
import type { ScheduleTrip } from '../../../transit/gtfs/static/schema';
import { TransitToolError, asTransitRef, boundedText, checkState, guarded, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, unavailable, validRef } from './shared';

const departureShape = { tripRef: z.string(), serviceDate: z.string(), routeRef: z.string(), agencyRef: z.string(), stopRef: z.string(), stopSequence: z.number().int(),
  headsign: z.string(), directionId: z.number().int().nullable(), pickupType: z.number().int(), status: z.enum(['scheduled_only', 'realtime']), feedId: z.string(), scheduleVersion: z.string(), agencyTimezone: z.string() };
const departureSchema = z.strictObject({ ...departureShape, tripInstanceRef: z.string(), scheduledTime: instantSchema, predictedTime: instantSchema.nullable(), platform: z.string().nullable() });
const frequencySchema = z.strictObject({ ...departureShape, tripTemplateRef: z.string(), startTime: instantSchema, endTime: instantSchema, overlapStartTime: instantSchema, overlapEndTime: instantSchema,
  headwaySeconds: z.number().int(), exactTimes: z.literal(false) });
export function registerDeparturesTool(server: McpServer, context: MetroMcpContext): void {
  server.registerTool('get_departures', {
    title: 'Departures at a stop', description: 'Find what leaves a stop next, the first service or last service in a bounded window. Returns dated trip references for get_vehicle_status. Use plan_trip for every journey; departures cannot establish a route or connection.',
    annotations: readOnlyLive('Departures at a stop'),
    inputSchema: z.strictObject({ stopRef: boundedText, at: instantSchema.optional(), windowSeconds: z.number().int().default(7200).describe('Search window in seconds, 1 through 604800 (seven days).'),
      routeRefs: z.array(boundedText).max(20).optional(), agencyRefs: z.array(boundedText).max(20).optional(), selection: z.enum(['first', 'last']).default('first'), limit: z.number().int().min(1).max(100).default(20) }),
    outputSchema: z.strictObject({ ...resultShape, departures: z.array(departureSchema), frequencyWindows: z.array(frequencySchema) }),
  }, async (args, handler) => guarded(handler, async () => {
    checkState(handler, 'get_departures');
    if (args.windowSeconds < 1 || args.windowSeconds > 604800) throw new TransitToolError('TIME_OUTSIDE_WINDOW');
    const stop = validRef(args.stopRef, ['stop']);
    for (const ref of args.routeRefs ?? []) validRef(ref, ['route']);
    for (const ref of args.agencyRefs ?? []) validRef(ref, ['agency']);
    const data = await loadData(context, stop.coverage, handler.mcpReq.signal);
    if (!data) return complete({ ...unavailable(stop.coverage), departures: [], frequencyWindows: [] });
    knownEntity(data, args.stopRef);
    for (const ref of [...args.routeRefs ?? [], ...args.agencyRefs ?? []]) knownEntity(data, ref);
    const now = new Date().toISOString(), nowSeconds = Date.parse(now) / 1000;
    const relevantStops = new Set(data.indexes.flatMap(index => index.stops).filter(stop => stop.ref === args.stopRef || stop.parentStationRef === args.stopRef).map(stop => stop.ref));
    const trips = new Map<string, Pick<ScheduleTrip, 'headsign' | 'directionId' | 'routeRef' | 'stopTimes'>>();
    const pages = getScheduledDeparturePages({ manifest: data.manifest, readShard: async key => {
      const bytes = await data.readObject(key), shard = decodeScheduleShard(bytes);
      for (const trip of shard.trips) {
        const stopTimes = trip.stopTimes.filter(call => relevantStops.has(call.stopRef));
        if (stopTimes.length) trips.set(trip.ref, { headsign: trip.headsign, directionId: trip.directionId, routeRef: trip.routeRef, stopTimes });
      }
      return bytes;
    }, readDiscovery: data.readObject, stopRef: asTransitRef(args.stopRef),
      instant: args.at ?? now, windowSeconds: args.windowSeconds, selection: args.selection, limit: 100, routeRefs: args.routeRefs?.map(asTransitRef), agencyRefs: args.agencyRefs?.map(asTransitRef) });
    const scheduled: ScheduledDeparture[] = []; let schedule: ScheduledDepartures | undefined;
    // Predictions can reorder any scheduled page. Exhaust the bounded window before ranking.
    for await (const page of pages) { handler.mcpReq.signal.throwIfAborted(); schedule = page; scheduled.push(...page.departures); }
    if (!schedule) throw new Error('Missing departure scan');
    const feed = await readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', nowSeconds, handler.mcpReq.signal);
    const fresh = feed?.status === 'realtime' && feed.producerTimestampSeconds !== undefined && nowSeconds >= feed.producerTimestampSeconds && nowSeconds - feed.producerTimestampSeconds <= data.coverage.thresholds.tripUpdates.realtimeSeconds;
    let departures: z.infer<typeof departureSchema>[] = scheduled.flatMap(departure => {
      const update = fresh ? feed.payload?.find(update => update.tripInstanceRef === departure.tripInstanceRef && update.stopSequence === departure.stopSequence && update.stopId === parseTransitRef(departure.stopRef)!.id) : undefined;
      if (update?.status === 'canceled' || update?.status === 'skipped') return [];
      const prediction = update?.status === 'realtime' ? update.departureTimeSeconds ?? update.arrivalTimeSeconds : undefined;
      return [{ ...departure, predictedTime: prediction === undefined ? null : new Date(prediction * 1000).toISOString(), platform: null, status: prediction === undefined ? 'scheduled_only' as const : 'realtime' as const }];
    });
    for (const update of fresh ? feed.payload ?? [] : []) {
      if (!update.tripInstanceRef || update.status !== 'realtime' || departures.some(row => row.tripInstanceRef === update.tripInstanceRef && row.stopSequence === update.stopSequence)) continue;
      const instance = parseTransitRef(update.tripInstanceRef);
      if (!instance || instance.kind !== 'trip' || !('serviceDate' in instance)) continue;
      const tripRef = formatEntityRef(instance), trip = trips.get(tripRef);
      const call = trip?.stopTimes.find(call => call.sequence === update.stopSequence && parseTransitRef(call.stopRef)?.id === update.stopId && call.pickupType !== 1);
      const route = data.indexes.flatMap(index => index.routes).find(route => route.ref === trip?.routeRef);
      const predicted = update.departureTimeSeconds ?? update.arrivalTimeSeconds, scheduled = update.scheduledDepartureTimeSeconds ?? update.scheduledArrivalTimeSeconds;
      if (!trip || !call || !route || predicted === undefined || scheduled === undefined || args.routeRefs && !args.routeRefs.includes(route.ref) || args.agencyRefs && !args.agencyRefs.includes(route.agencyRef)) continue;
      departures.push({ tripRef, tripInstanceRef: update.tripInstanceRef, serviceDate: instance.serviceDate, routeRef: route.ref, agencyRef: route.agencyRef,
        stopRef: call.stopRef, stopSequence: call.sequence, headsign: call.headsign || trip.headsign, directionId: trip.directionId, pickupType: call.pickupType,
        scheduledTime: new Date(scheduled * 1000).toISOString(), predictedTime: new Date(predicted * 1000).toISOString(), platform: null, status: 'realtime',
        feedId: instance.feed, scheduleVersion: data.version.sourceVersions[instance.feed]!, agencyTimezone: data.manifest.agencyTimezones[route.agencyRef]! });
    }
    const start = Date.parse(args.at ?? now), end = start + args.windowSeconds * 1000, direction = args.selection === 'last' ? -1 : 1;
    const time = (row: z.infer<typeof departureSchema>) => Date.parse(row.predictedTime ?? row.scheduledTime);
    departures = departures.filter(row => time(row) >= start && time(row) < end).sort((a, b) => direction * (time(a) - time(b)) || a.tripInstanceRef.localeCompare(b.tripInstanceRef) || a.stopSequence - b.stopSequence).slice(0, args.limit);
    const meta = metadata(stop.coverage, data, now);
    return complete({ ...meta, sources: [...meta.sources, ...(feed ? realtimeSource(data, feed, 'trip_updates', nowSeconds) : [])],
      status: departures.some(row => row.status === 'realtime') ? 'realtime' as const : schedule.status, reasons: schedule.reasons, departures, frequencyWindows: schedule.frequencyWindows });
  }, () => complete({ ...unavailable(parseTransitRef(args.stopRef)?.coverage), departures: [], frequencyWindows: [] })));
}
