import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { parseTransitRef } from '../../../transit/core/refs';
import type { NormalizedVehicle } from '../../../transit/gtfs/realtime/decode';
import { boundedText, checkState, coordinatesSchema, guarded, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, unavailable, validRef } from './shared';

export function registerVehicleStatusTool(server: McpServer, context: MetroMcpContext): void {
  server.registerTool('get_vehicle_status', {
    title: 'Observed transit vehicles', description: 'Locate an observed vehicle on a dated trip or list observed vehicles on a route. Requires a dated trip-instance or route reference, never a bare train number or stop. Use find_transit to resolve identity and get_departures for approaching service.',
    annotations: readOnlyLive('Observed transit vehicles'),
    inputSchema: z.strictObject({ ref: boundedText, limit: z.number().int().min(1).max(100).default(20) }),
    outputSchema: z.strictObject({ ...resultShape, vehicles: z.array(z.strictObject({ id: z.string(), tripInstanceRef: z.string().nullable(), routeRef: z.string().nullable(),
      coordinates: coordinatesSchema, bearing: z.number().nullable(), speedMetersPerSecond: z.number().nullable(), observedAt: instantSchema, ageSeconds: z.number().nonnegative() })) }),
  }, async (args, handler) => guarded(handler, async () => {
    checkState(handler, 'get_vehicle_status');
    const parsed = validRef(args.ref, ['route', 'trip'], true);
    const data = await loadData(context, parsed.coverage, handler.mcpReq.signal);
    if (!data) return complete({ ...unavailable(parsed.coverage), vehicles: [] });
    knownEntity(data, args.ref);
    const now = Math.floor(Date.now() / 1000), feed = await readFeed<NormalizedVehicle>(context, data, 'vehicle_positions', now, handler.mcpReq.signal);
    const fresh = feed?.status === 'realtime' && feed.producerTimestampSeconds !== undefined && now >= feed.producerTimestampSeconds && now - feed.producerTimestampSeconds <= data.coverage.thresholds.vehiclePositions.realtimeSeconds;
    const vehicles = (fresh ? feed.payload ?? [] : []).filter(vehicle => (parsed.kind === 'trip' ? vehicle.tripInstanceRef === args.ref : vehicle.routeId === parsed.id) &&
      vehicle.timestampSeconds !== undefined && now >= vehicle.timestampSeconds && now - vehicle.timestampSeconds <= data.coverage.thresholds.vehiclePositions.realtimeSeconds).slice(0, args.limit).map(vehicle => ({
      id: vehicle.vehicleId ?? vehicle.entityId, tripInstanceRef: vehicle.tripInstanceRef ?? null,
      routeRef: data.indexes.flatMap(index => index.routes).find(route => route.providerId === vehicle.routeId)?.ref ?? null,
      coordinates: { latitude: vehicle.latitude, longitude: vehicle.longitude }, bearing: vehicle.bearing ?? null, speedMetersPerSecond: vehicle.speedMetersPerSecond ?? null,
      observedAt: new Date(vehicle.timestampSeconds! * 1000).toISOString(), ageSeconds: now - vehicle.timestampSeconds!,
    }));
    const meta = metadata(parsed.coverage, data, new Date(now * 1000).toISOString());
    const available = fresh && (parsed.kind === 'route' || vehicles.length > 0);
    return complete({ ...meta, sources: [...meta.sources, ...(feed ? realtimeSource(data, feed, 'vehicle_positions', now) : [])],
      status: available ? 'realtime' as const : 'unavailable' as const, reasons: available ? [] : ['REALTIME_UNAVAILABLE' as const], vehicles });
  }, () => complete({ ...unavailable(parseTransitRef(args.ref)?.coverage, undefined, ['REALTIME_UNAVAILABLE']), vehicles: [] })));
}
