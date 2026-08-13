import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getTransitClient } from '../../transit/registry';
import type { WMATAClient } from '../../transit/wmata-client';
import type { MetroMcpContext } from '../context';
import {
  READ_ONLY_LIVE,
  complete,
  coordinatesSchema,
  withTransitErrors,
} from '../shared';

/** Register the four DC bus tools in wire-visible order. */
export function registerBusTools(
  server: McpServer,
  context: MetroMcpContext,
): void {
  server.registerTool(
    'get_bus_predictions',
    {
      title: 'Bus arrival predictions',
      description: 'Get real-time bus arrival predictions for a DC Metro bus stop.',
      annotations: READ_ONLY_LIVE,
      inputSchema: z.object({
        stopId: z.string().describe(
          'DC Metro 7-digit regional bus stop ID (e.g., "1001195")',
        ),
      }),
      outputSchema: z.object({
        city: z.literal('dc'),
        stopId: z.string(),
        predictions: z.array(z.object({
          route: z.string(),
          direction: z.string(),
          minutesAway: z.number().int(),
          vehicleId: z.string().nullable(),
          tripId: z.string().nullable(),
        })),
      }),
    },
    async ({ stopId }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const predictions = await (getTransitClient(
        'dc',
        context.env,
      ) as WMATAClient).getBusPredictions(stopId, signal);
      return complete({
        city: 'dc' as const,
        stopId,
        predictions: predictions.map(prediction => ({
          route: prediction.RouteID,
          direction: prediction.DirectionText,
          minutesAway: prediction.Minutes,
          vehicleId: prediction.VehicleID ?? null,
          tripId: prediction.TripID ?? null,
        })),
      });
    }, handlerContext.mcpReq.signal),
  );

  server.registerTool(
    'get_bus_routes',
    {
      title: 'All bus routes',
      description: 'Get all DC Metro bus routes with route IDs and descriptions.',
      annotations: READ_ONLY_LIVE,
      inputSchema: z.object({}),
      outputSchema: z.object({
        city: z.literal('dc'),
        totalRoutes: z.number().int(),
        routes: z.array(z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable(),
        })),
      }),
    },
    async (_args, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const routes = await (getTransitClient(
        'dc',
        context.env,
      ) as WMATAClient).getBusRoutes(signal);
      return complete({
        city: 'dc' as const,
        totalRoutes: routes.length,
        routes: routes.map(route => ({
          id: route.RouteID,
          name: route.Name,
          description: route.LineDescription ?? null,
        })),
      });
    }, handlerContext.mcpReq.signal),
  );

  server.registerTool(
    'get_bus_stops',
    {
      title: 'Bus stops',
      description: 'Get DC Metro bus stops. Returns all stops or filters by lat/lon/radius.',
      annotations: READ_ONLY_LIVE,
      inputSchema: z.object({
        latitude: z.number().optional().describe('Center latitude for geographic search'),
        longitude: z.number().optional().describe('Center longitude for geographic search'),
        radius: z.number().optional().describe('Search radius in meters'),
      }),
      outputSchema: z.object({
        city: z.literal('dc'),
        totalStops: z.number().int(),
        searchLocation: z.object({
          lat: z.number(),
          lon: z.number(),
          radiusMeters: z.number().nullable(),
        }).nullable(),
        stops: z.array(z.object({
          id: z.string(),
          name: z.string(),
          coordinates: coordinatesSchema,
          routes: z.array(z.string()),
        })),
      }),
    },
    async ({ latitude, longitude, radius }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const stops = await (getTransitClient(
        'dc',
        context.env,
      ) as WMATAClient).getBusStops(latitude, longitude, radius, signal);
      return complete({
        city: 'dc' as const,
        totalStops: stops.length,
        searchLocation: latitude !== undefined && longitude !== undefined
          ? { lat: latitude, lon: longitude, radiusMeters: radius ?? null }
          : null,
        stops: stops.map(stop => ({
          id: stop.StopID,
          name: stop.Name,
          coordinates: { lat: stop.Lat, lon: stop.Lon },
          routes: stop.Routes,
        })),
      });
    }, handlerContext.mcpReq.signal),
  );

  server.registerTool(
    'get_bus_positions',
    {
      title: 'Live bus positions',
      description: 'Get real-time positions of DC Metro buses, optionally filtered by route.',
      annotations: READ_ONLY_LIVE,
      inputSchema: z.object({
        routeId: z.string().optional().describe(
          'Optional route ID filter (e.g., "30N"). Omit for all buses.',
        ),
      }),
      outputSchema: z.object({
        city: z.literal('dc'),
        routeFilter: z.string().nullable(),
        totalBuses: z.number().int(),
        buses: z.array(z.object({
          vehicleId: z.string(),
          route: z.string(),
          direction: z.string(),
          coordinates: coordinatesSchema,
          headsign: z.string().nullable(),
          deviation: z.number().nullable(),
          lastUpdated: z.string(),
        })),
      }),
    },
    async ({ routeId }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const positions = await (getTransitClient(
        'dc',
        context.env,
      ) as WMATAClient).getBusPositions(routeId, signal);
      return complete({
        city: 'dc' as const,
        routeFilter: routeId ?? null,
        totalBuses: positions.length,
        buses: positions.map(bus => ({
          vehicleId: bus.VehicleID,
          route: bus.RouteID,
          direction: bus.DirectionText,
          coordinates: { lat: bus.Lat, lon: bus.Lon },
          headsign: bus.TripHeadsign ?? null,
          deviation: bus.Deviation ?? null,
          lastUpdated: bus.DateTime,
        })),
      });
    }, handlerContext.mcpReq.signal),
  );
}
