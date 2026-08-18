import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { formatElevatorIncidentsForMcp } from '../elevator-format';
import { getTransitClient } from '../../transit/registry';
import type { SupportedCity } from '../../transit/base';
import type { WMATAClient } from '../../transit/wmata-client';
import type { MetroMcpContext } from '../context';
import {
  READ_ONLY_LIVE,
  citySchema,
  complete,
  withTransitErrors,
} from '../shared';

/** Register service and elevator incident tools in wire-visible order. */
export function registerIncidentTools(
  server: McpServer,
  context: MetroMcpContext,
): void {
  server.registerTool(
    'get_incidents',
    {
      title: 'Service incidents',
      description: 'Get current transit incidents and service advisories.',
      annotations: READ_ONLY_LIVE,
      inputSchema: z.object({ city: citySchema }),
      outputSchema: z.object({
        city: citySchema,
        incidents: z.array(z.object({
          id: z.string(),
          description: z.string(),
          linesAffected: z.array(z.string()),
          severity: z.string(),
          type: z.string(),
          lastUpdated: z.string(),
        })),
      }),
    },
    async ({ city }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const incidents = await getTransitClient(
        city as SupportedCity,
        context.env,
      ).getIncidents(signal);
      return complete({
        city,
        incidents: incidents.map(incident => ({
          id: incident.incidentId,
          description: incident.description,
          linesAffected: incident.linesAffected,
          severity: incident.severity,
          type: incident.incidentType,
          lastUpdated: incident.timestamp,
        })),
      });
    }, handlerContext.mcpReq.signal),
  );

  server.registerTool(
    'get_elevator_incidents',
    {
      title: 'Elevator outages',
      description: 'Get current elevator and escalator outages. DC Metro only.',
      annotations: READ_ONLY_LIVE,
      inputSchema: z.object({ city: z.enum(['dc']) }),
      outputSchema: z.object({
        city: z.enum(['dc']),
        elevatorIncidents: z.array(z.object({
          id: z.string(),
          description: z.string(),
          unitName: z.string(),
          unitType: z.string(),
          stationCode: z.string(),
          stationName: z.string(),
          locationDescription: z.string(),
          symptomDescription: z.string(),
          outOfServiceAt: z.string(),
          estimatedReturnToService: z.string().nullable(),
          lastUpdated: z.string(),
        })),
      }),
    },
    async ({ city }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const client = getTransitClient(
        city as SupportedCity,
        context.env,
      ) as WMATAClient;
      const incidents = await client.getElevatorIncidents(signal);
      return complete({
        city,
        elevatorIncidents: formatElevatorIncidentsForMcp(incidents),
      });
    }, handlerContext.mcpReq.signal),
  );
}
