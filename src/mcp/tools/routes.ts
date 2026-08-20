import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getTransitClient } from '../../transit/registry';
import type { SupportedCity } from '../../transit/base';
import type { MetroMcpContext } from '../context';
import { TRANSIT_BOARD_TOOL_META } from '../apps';
import { READ_ONLY_LIVE, complete, withTransitErrors } from '../shared';

/** Register the NYC route information tool. */
export function registerRouteTools(
  server: McpServer,
  context: MetroMcpContext,
): void {
  server.registerTool(
    'get_route_info',
    {
      title: 'Route information',
      description:
        'Get detailed information about a transit route including service patterns. NYC Subway only.',
      annotations: READ_ONLY_LIVE,
      _meta: TRANSIT_BOARD_TOOL_META,
      inputSchema: z.object({
        city: z.enum(['nyc']),
        routeId: z.string().describe(
          'Route identifier — NYC: A, B, C, D, E, F, M, G, J, Z, L, N, Q, R, W, 1, 2, 3, 4, 5, 6, 7, SI',
        ),
      }),
      outputSchema: z.object({
        city: z.enum(['nyc']),
        routeId: z.string(),
        shortName: z.string(),
        longName: z.string(),
        description: z.string(),
      }),
    },
    async ({ city, routeId }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const route = await getTransitClient(
        city as SupportedCity,
        context.env,
      ).getRouteInfo(routeId, signal);
      if (!route) {
        throw new Error(
          `Route not found: ${routeId}. Make sure you're using the correct ID for ${city}.`,
        );
      }
      return complete({
        city,
        routeId: route.routeId,
        shortName: route.shortName,
        longName: route.longName,
        description: route.description,
      });
    }, handlerContext.mcpReq.signal),
  );
}
