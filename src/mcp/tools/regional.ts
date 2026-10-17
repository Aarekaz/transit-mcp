import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../context';
import { complete, readOnlyLive, withTransitErrors } from '../shared';
import { SFBAY_REGION } from '../../regions/sfbay';
import { createRegionalTransitService } from '../../transit/gtfs/realtime/service';

export function registerRegionalTools(server: McpServer, context: MetroMcpContext): void {
  const service = () => context.deps?.regionalTransitService ?? createRegionalTransitService(context.env);
  const attribution = SFBAY_REGION.attribution;

  server.registerTool('search_sfbay_stations', {
    title: 'Search Bay Area stations',
    description: 'Search stops and stations across the San Francisco Bay Area regional transit network.',
    annotations: readOnlyLive('Search Bay Area stations'),
    inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) }),
    outputSchema: z.object({
      city: z.literal('sfbay'), query: z.string(), attribution: z.object({ text: z.string(), url: z.string().url() }),
      results: z.array(z.object({ id: z.string(), name: z.string(), latitude: z.number(), longitude: z.number(), routes: z.array(z.string()) })),
    }),
  }, async ({ query, limit }, handlerContext) => withTransitErrors(async () => complete({
    city: 'sfbay' as const, query, attribution,
    results: (await service().searchStations(query)).slice(0, limit).map(station => ({
      id: station.id, name: station.name, latitude: station.latitude, longitude: station.longitude, routes: station.routeIds,
    })),
  }), handlerContext.mcpReq.signal));

  server.registerTool('get_sfbay_station_predictions', {
    title: 'Bay Area station arrivals',
    description: 'Get current regional arrival predictions for an exact Bay Area stop or station ID.',
    annotations: readOnlyLive('Bay Area station arrivals'),
    inputSchema: z.object({ stationId: z.string().min(1) }),
    outputSchema: z.object({
      city: z.literal('sfbay'), stationId: z.string(), freshness: z.enum(['fresh', 'stale', 'expired', 'unavailable']),
      warnings: z.array(z.string()), attribution: z.object({ text: z.string(), url: z.string().url() }),
      predictions: z.array(z.object({ routeId: z.string().nullable(), tripId: z.string().nullable(), arrivalTime: z.string().nullable(), departureTime: z.string().nullable(), minutesAway: z.number().int().nullable() })),
    }),
  }, async ({ stationId }, handlerContext) => withTransitErrors(async () => {
    const now = Math.floor(Date.now() / 1_000);
    const snapshot = await service().getStationPredictions(stationId, now);
    return complete({
      city: 'sfbay' as const, stationId, freshness: snapshot.freshness, warnings: snapshot.warnings, attribution,
      predictions: (snapshot.payload ?? []).map(update => ({
        routeId: update.routeId ?? null, tripId: update.tripId ?? null,
        arrivalTime: update.arrivalTimeSeconds == null ? null : new Date(update.arrivalTimeSeconds * 1_000).toISOString(),
        departureTime: update.departureTimeSeconds == null ? null : new Date(update.departureTimeSeconds * 1_000).toISOString(),
        minutesAway: update.arrivalTimeSeconds == null ? null : Math.max(0, Math.ceil((update.arrivalTimeSeconds - now) / 60)),
      })),
    });
  }, handlerContext.mcpReq.signal));

  server.registerTool('get_sfbay_routes', {
    title: 'Bay Area routes', description: 'List routes across the San Francisco Bay Area regional transit network.',
    annotations: readOnlyLive('Bay Area routes'), inputSchema: z.object({}),
    outputSchema: z.object({ city: z.literal('sfbay'), attribution: z.object({ text: z.string(), url: z.string().url() }), routes: z.array(z.object({ id: z.string(), shortName: z.string(), longName: z.string(), mode: z.string(), color: z.string().nullable() })) }),
  }, async (_args, handlerContext) => withTransitErrors(async () => complete({
    city: 'sfbay' as const, attribution,
    routes: (await service().getRoutes()).map(route => ({ ...route, color: route.color ?? null })),
  }), handlerContext.mcpReq.signal));

  server.registerTool('get_sfbay_incidents', {
    title: 'Bay Area service alerts', description: 'Get current service alerts across the San Francisco Bay Area regional transit network.',
    annotations: readOnlyLive('Bay Area service alerts'), inputSchema: z.object({}),
    outputSchema: z.object({ city: z.literal('sfbay'), freshness: z.enum(['fresh', 'stale', 'expired', 'unavailable']), warnings: z.array(z.string()), attribution: z.object({ text: z.string(), url: z.string().url() }), incidents: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), routeIds: z.array(z.string()), stopIds: z.array(z.string()) })) }),
  }, async (_args, handlerContext) => withTransitErrors(async () => {
    const snapshot = await service().getAlerts(Math.floor(Date.now() / 1_000));
    return complete({ city: 'sfbay' as const, freshness: snapshot.freshness, warnings: snapshot.warnings, attribution,
      incidents: (snapshot.payload ?? []).map(alert => ({ id: alert.id, title: alert.header, description: alert.description, routeIds: alert.routeIds, stopIds: alert.stopIds })),
    });
  }, handlerContext.mcpReq.signal));

  server.registerTool(
    'get_vehicle_positions',
    {
      title: 'Regional vehicle positions',
      description: 'Get current vehicle positions for the San Francisco Bay Area regional transit network.',
      annotations: readOnlyLive('Regional vehicle positions'),
      inputSchema: z.object({ city: z.literal('sfbay') }),
      outputSchema: z.object({
        city: z.literal('sfbay'),
        freshness: z.enum(['fresh', 'stale', 'expired', 'unavailable']),
        producerTimestamp: z.string().nullable(),
        warnings: z.array(z.string()),
        attribution: z.object({ text: z.string(), url: z.string().url() }),
        vehicles: z.array(z.object({
          id: z.string(),
          label: z.string().nullable(),
          routeId: z.string().nullable(),
          tripId: z.string().nullable(),
          latitude: z.number(),
          longitude: z.number(),
          bearing: z.number().nullable(),
          speedMetersPerSecond: z.number().nullable(),
          updatedAt: z.string().nullable(),
        })),
      }),
    },
    async (_args, handlerContext) => withTransitErrors(async () => {
      const snapshot = await service().getVehiclePositions(Math.floor(Date.now() / 1_000));
      return complete({
        city: 'sfbay' as const,
        freshness: snapshot.freshness,
        producerTimestamp: snapshot.producerTimestampSeconds == null
          ? null
          : new Date(snapshot.producerTimestampSeconds * 1_000).toISOString(),
        warnings: snapshot.warnings,
        attribution: SFBAY_REGION.attribution,
        vehicles: (snapshot.payload ?? []).map(vehicle => ({
          id: vehicle.vehicleId ?? vehicle.entityId,
          label: vehicle.label ?? null,
          routeId: vehicle.routeId ?? null,
          tripId: vehicle.tripId ?? null,
          latitude: vehicle.latitude,
          longitude: vehicle.longitude,
          bearing: vehicle.bearing ?? null,
          speedMetersPerSecond: vehicle.speedMetersPerSecond ?? null,
          updatedAt: vehicle.timestampSeconds == null
            ? null
            : new Date(vehicle.timestampSeconds * 1_000).toISOString(),
        })),
      });
    }, handlerContext.mcpReq.signal),
  );
}
