import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { formatEntityRef, parseTransitRef } from '../../../transit/core/refs';
import { getCoverage } from '../../../transit/core/coverage';
import type { NormalizedVehicle } from '../../../transit/gtfs/realtime/decode';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { MAX_DISCOVERY_CANDIDATES, TransitToolError, boundedText, checkState, complexStations, coordinatesSchema, coverageSchema, guarded, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, routeName, stopMatches, unavailable, validRef, type TransitData } from './shared';

const STOP_STATUS = { STOPPED_AT: 'stopped_at', INCOMING_AT: 'incoming_at', IN_TRANSIT_TO: 'in_transit_to' } as const;

export function registerVehicleStatusTool(server: McpServer, context: MetroMcpContext): void {
  server.registerTool('get_vehicle_status', {
    title: 'Where trains are now',
    description: 'Where observed trains are right now. Pass a route ref to list its trains, a dated trip ref (from get_departures or a plan_trip leg) to find that train, or a station (stopRef, or a name with coverage) to see trains stopped at or heading to it; a station covers its whole complex. Each train reports the stop it is at or heading to (stopStatus), the stop it last served, and its destination. Coordinates are the vehicle\'s own when the agency sends them (DC); otherwise a stopped train is placed at its station and a moving one has none. Never pass a bare train number: use find_transit.',
    annotations: readOnlyLive('Where trains are now'),
    inputSchema: z.strictObject({
      ref: boundedText.optional().describe('Route, dated trip or stop/station reference. Give this or stop.'),
      stop: boundedText.optional().describe('Station name, with coverage. Give this or ref.'), coverage: coverageSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    outputSchema: z.strictObject({ ...resultShape, vehicles: z.array(z.strictObject({ id: z.string(),
      trainId: z.string().nullable().describe('The agency\'s train identifier: an NYCT train ID such as "1A 1023 207/FAR" (line, scheduled origin time, origin/destination) or the label WMATA publishes. find_transit resolves it to this train\'s trip.'),
      tripInstanceRef: z.string().nullable(), routeRef: z.string().nullable(),
      routeName: z.string().nullable().describe('Public route name, e.g. "A" or "Red".'), headsign: z.string().nullable(),
      stopStatus: z.enum(['stopped_at', 'incoming_at', 'in_transit_to']).nullable().describe('Relation to stopRef: stopped there, arriving, or travelling towards it.'),
      stopRef: z.string().nullable(), stopName: z.string().nullable(),
      previousStopRef: z.string().nullable().describe('The scheduled stop before stopRef while the train is between stops; null when stopped or off its scheduled pattern.'),
      previousStopName: z.string().nullable(),
      coordinates: coordinatesSchema.nullable(), coordinatesSource: z.enum(['vehicle', 'stop']).nullable(),
      bearing: z.number().nullable(), speedMetersPerSecond: z.number().nullable(), observedAt: instantSchema, ageSeconds: z.number().nonnegative() })) }),
  }, async (args, handler) => guarded(handler, async () => {
    checkState(handler, 'get_vehicle_status');
    if (!args.ref === !args.stop) throw new TransitToolError('INVALID_TRANSIT_REF');
    let ref = args.ref, data: TransitData | null = null;
    if (args.stop) {
      const coverageId = getCoverage(args.coverage ?? '')?.id;
      if (!coverageId) throw new TransitToolError('ENTITY_NOT_FOUND');
      data = await loadData(context, coverageId, handler.mcpReq.signal);
      if (!data) return complete({ ...unavailable(coverageId), vehicles: [] });
      const matches = stopMatches(data, args.stop);
      if (!matches.length) throw new TransitToolError('ENTITY_NOT_FOUND');
      if (matches.length > MAX_DISCOVERY_CANDIDATES) return complete({ ...unavailable(coverageId, data, ['SCOPE_LIMIT_EXCEEDED']), vehicles: [] });
      if (matches.length > 1) throw new TransitToolError('ENTITY_AMBIGUOUS', matches);
      ref = matches[0]!.ref;
    }
    const parsed = validRef(ref!, ['route', 'trip', 'stop'], true);
    data ??= await loadData(context, parsed.coverage, handler.mcpReq.signal);
    if (!data) return complete({ ...unavailable(parsed.coverage), vehicles: [] });
    knownEntity(data, ref!);
    const stopIndex = data.indexes.flatMap(index => index.stops), byRef = new Map(stopIndex.map(stop => [stop.ref as string, stop]));
    const within = parsed.kind === 'stop' ? new Set([ref!, ...complexStations(data, ref!)]) : undefined;
    const atStop = within && new Set(stopIndex.filter(stop => within.has(stop.ref) || stop.parentStationRef !== undefined && within.has(stop.parentStationRef)).map(stop => stop.providerId));
    const now = Math.floor(Date.now() / 1000), feed = await readFeed<NormalizedVehicle>(context, data, 'vehicle_positions', now, handler.mcpReq.signal, [], [parsed.feed]);
    const fresh = (feed.feedIds ?? [feed.feedId]).includes(parsed.feed) && feed?.status === 'realtime' && feed.producerTimestampSeconds !== undefined && now >= feed.producerTimestampSeconds && now - feed.producerTimestampSeconds <= data.coverage.thresholds.vehiclePositions.realtimeSeconds;
    const routes = data.indexes.find(index => index.feedId === parsed.feed)?.routes ?? [];
    const stopRef = (providerId: string | undefined) => {
      const candidate = providerId === undefined ? undefined : formatEntityRef({ coverage: parsed.coverage, feed: parsed.feed, kind: 'stop', id: providerId });
      return candidate !== undefined && byRef.has(candidate) ? candidate : null;
    };
    // Riders know platforms by their station's name.
    const stopName = (ref: string | null) => {
      const stop = ref === null ? undefined : byRef.get(ref), parent = stop?.parentStationRef ? byRef.get(stop.parentStationRef) : undefined;
      return stop ? sanitizeTransitText(parent?.name ?? stop.name, 200) : null;
    };
    const order = { STOPPED_AT: 0, INCOMING_AT: 1, IN_TRANSIT_TO: 2 } as const;
    const vehicles = (fresh ? feed.payload ?? [] : []).filter(vehicle => (parsed.kind === 'trip' ? vehicle.tripInstanceRef === ref : parsed.kind === 'route' ? vehicle.routeId === parsed.id : vehicle.stopId !== undefined && atStop!.has(vehicle.stopId)) &&
      vehicle.timestampSeconds !== undefined && now >= vehicle.timestampSeconds && now - vehicle.timestampSeconds <= data.coverage.thresholds.vehiclePositions.realtimeSeconds)
      .sort((a, b) => parsed.kind === 'stop' ? order[a.currentStatus ?? 'IN_TRANSIT_TO'] - order[b.currentStatus ?? 'IN_TRANSIT_TO'] || b.timestampSeconds! - a.timestampSeconds! : 0)
      .slice(0, args.limit).map(vehicle => {
        const route = routes.find(route => route.providerId === vehicle.routeId), at = stopRef(vehicle.stopId), previous = stopRef(vehicle.previousStopId);
        const station = at === null ? undefined : byRef.get(at), stationParent = station?.parentStationRef ? byRef.get(station.parentStationRef) : undefined;
        const stationLatitude = station?.latitude ?? stationParent?.latitude, stationLongitude = station?.longitude ?? stationParent?.longitude;
        const coordinates = vehicle.latitude !== undefined && vehicle.longitude !== undefined ? { coordinates: { latitude: vehicle.latitude, longitude: vehicle.longitude }, coordinatesSource: 'vehicle' as const } :
          vehicle.currentStatus === 'STOPPED_AT' && stationLatitude != null && stationLongitude != null ? { coordinates: { latitude: stationLatitude, longitude: stationLongitude }, coordinatesSource: 'stop' as const } :
          { coordinates: null, coordinatesSource: null };
        const trainId = vehicle.trainId ?? vehicle.label;
        return { id: vehicle.vehicleId ?? vehicle.entityId, trainId: trainId ? sanitizeTransitText(trainId, 40) : null, tripInstanceRef: vehicle.tripInstanceRef ?? null, routeRef: route?.ref ?? null,
          routeName: route ? routeName(route) : null, headsign: vehicle.headsign ? sanitizeTransitText(vehicle.headsign, 200) : null,
          stopStatus: at !== null && vehicle.currentStatus ? STOP_STATUS[vehicle.currentStatus] : null, stopRef: at, stopName: stopName(at),
          previousStopRef: previous, previousStopName: stopName(previous), ...coordinates,
          bearing: vehicle.bearing ?? null, speedMetersPerSecond: vehicle.speedMetersPerSecond ?? null,
          observedAt: new Date(vehicle.timestampSeconds! * 1000).toISOString(), ageSeconds: now - vehicle.timestampSeconds! };
      });
    const meta = metadata(parsed.coverage, data, new Date(now * 1000).toISOString());
    const available = fresh && (parsed.kind !== 'trip' || vehicles.length > 0);
    return complete({ ...meta, sources: [...meta.sources, ...(feed ? realtimeSource(data, feed, 'vehicle_positions', now) : [])],
      status: available ? 'realtime' as const : 'unavailable' as const, reasons: feed.reasons.length ? feed.reasons : available ? [] : ['REALTIME_UNAVAILABLE' as const], vehicles });
  }, () => complete({ ...unavailable(args.ref ? parseTransitRef(args.ref)?.coverage : getCoverage(args.coverage ?? '')?.id, undefined, ['REALTIME_UNAVAILABLE']), vehicles: [] })));
}
