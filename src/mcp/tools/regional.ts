import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../context';
import { complete, readOnlyLive, withTransitErrors } from '../shared';
import { SFBAY_REGION } from '../../regions/sfbay';
import { createRegionalTransitService } from '../../transit/gtfs/realtime/service';

export function registerRegionalTools(server: McpServer, context: MetroMcpContext): void {
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
      const service = context.deps?.regionalTransitService ?? createRegionalTransitService(context.env);
      if (!service) throw new Error('Bay Area regional service is not configured');
      const snapshot = await service.getVehiclePositions(Math.floor(Date.now() / 1_000));
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
