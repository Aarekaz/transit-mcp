import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/server';
import { getTransitClient } from '../transit/registry';
import type { SupportedCity } from '../transit/base';
import type { MetroMcpContext } from './context';
import {
  PRIVATE_NO_CACHE,
  PUBLIC_24H,
  withTransitErrors,
} from './shared';

const JSON_MIME_TYPE = 'application/json';

/** Register the three transit resource templates in wire-visible order. */
export function registerResources(
  server: McpServer,
  context: MetroMcpContext,
): void {
  server.registerResource(
    'station',
    new ResourceTemplate('transit://stations/{city}/{id}', { list: undefined }),
    {
      title: 'Transit station',
      description: 'Individual transit station metadata (coordinates, lines, address).',
      mimeType: JSON_MIME_TYPE,
      cacheHint: PUBLIC_24H,
    },
    async (uri, { city, id }, handlerContext) => withTransitErrors(async () => {
      const cityString = String(city);
      const idString = String(id);
      const signal = handlerContext.mcpReq.signal;
      const station = (await getTransitClient(
        cityString as SupportedCity,
        context.env,
      ).getStations(signal)).find(candidate => candidate.id === idString);
      if (!station) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Station not found: ${idString} (city: ${cityString})`,
        );
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: JSON_MIME_TYPE,
          text: JSON.stringify({
            id: station.id,
            name: station.name,
            lines: station.lines,
            coordinates: { lat: station.latitude, lon: station.longitude },
            address: station.address ?? null,
            transfers: station.transfers ?? [],
          }),
        }],
      };
    }, handlerContext.mcpReq.signal),
  );

  server.registerResource(
    'route',
    new ResourceTemplate('transit://routes/{city}/{id}', { list: undefined }),
    {
      title: 'Transit route',
      description:
        'Route metadata (service patterns, descriptions). NYC routes have rich data; DC currently does not.',
      mimeType: JSON_MIME_TYPE,
      cacheHint: PUBLIC_24H,
    },
    async (uri, { city, id }, handlerContext) => withTransitErrors(async () => {
      const cityString = String(city);
      const idString = String(id);
      const signal = handlerContext.mcpReq.signal;
      const route = await getTransitClient(
        cityString as SupportedCity,
        context.env,
      ).getRouteInfo(idString, signal);
      if (!route) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Route not found: ${idString} (city: ${cityString})`,
        );
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: JSON_MIME_TYPE,
          text: JSON.stringify(route),
        }],
      };
    }, handlerContext.mcpReq.signal),
  );

  server.registerResource(
    'incidents',
    new ResourceTemplate('transit://incidents/{city}', {
      list: async () => ({
        resources: [
          {
            uri: 'transit://incidents/dc',
            name: 'DC Metro incidents',
            description: 'Current service advisories for WMATA Metro.',
            mimeType: JSON_MIME_TYPE,
          },
          {
            uri: 'transit://incidents/nyc',
            name: 'NYC Subway incidents',
            description: 'Current service advisories for MTA Subway.',
            mimeType: JSON_MIME_TYPE,
          },
        ],
      }),
    }),
    {
      title: 'Transit incidents',
      description:
        'Live service advisories for a transit system. Read-only in 4.0; subscribe support arrives with the incident poller in Phase 2.5.',
      mimeType: JSON_MIME_TYPE,
      cacheHint: PRIVATE_NO_CACHE,
    },
    async (uri, { city }, handlerContext) => withTransitErrors(async () => {
      const cityString = String(city);
      const signal = handlerContext.mcpReq.signal;
      const incidents = await getTransitClient(
        cityString as SupportedCity,
        context.env,
      ).getIncidents(signal);
      return {
        contents: [{
          uri: uri.href,
          mimeType: JSON_MIME_TYPE,
          text: JSON.stringify({
            city: cityString,
            fetchedAt: new Date().toISOString(),
            incidents: incidents.map(incident => ({
              id: incident.incidentId,
              description: incident.description,
              linesAffected: incident.linesAffected,
              severity: incident.severity,
              type: incident.incidentType,
              lastUpdated: incident.timestamp,
            })),
          }),
        }],
      };
    }, handlerContext.mcpReq.signal),
  );
}
