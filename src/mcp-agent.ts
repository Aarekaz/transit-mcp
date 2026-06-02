import { McpAgent } from 'agents/mcp';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Env } from './types';
import { SERVER_VERSION } from './config';
import { getTransitClient } from './transit/registry';
import { SupportedCity } from './transit/base';
import { WMATAClient } from './transit/wmata-client';
import { handleWMATAError } from './error-handler';

/**
 * Per-session authentication context, propagated from the JWT verified
 * at the Worker shell. The DO can read these without re-verifying the
 * token on every message — verification happens once at session start.
 */
export interface Props extends Record<string, unknown> {
  userId: string;
  userLogin: string;
  /** RFC 8707 audience bound to this token, if any. Absent on legacy tokens. */
  audience?: string;
}

// ─── Shared Zod sub-schemas ──────────────────────────────────────────
const citySchema = z.enum(['dc', 'nyc']);
const coordinatesSchema = z.object({ lat: z.number(), lon: z.number() });
const addressSchema = z
  .object({
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional()
  })
  .nullable();
const stationItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  lines: z.array(z.string()),
  coordinates: coordinatesSchema,
  address: addressSchema
});

// Default annotations: every Metro MCP tool is a pure live-data read.
const READ_ONLY_LIVE = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true
} as const;

/**
 * Wrap a tool body so transit-API errors map to readable messages.
 * The SDK already turns thrown errors into `isError: true` tool results;
 * this just normalizes the message via the shared WMATA error mapper.
 */
async function withTransitErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(handleWMATAError(err));
  }
}

/**
 * MetroMcpAgent — Durable Object-backed MCP server.
 *
 * Inherits from cloudflare/agents' McpAgent (which extends Agent → DurableObject)
 * to get a managed session lifecycle:
 *
 *   - One DO instance per Mcp-Session-Id (auto-issued on initialize)
 *   - Streamable HTTP, SSE, and RPC transports (`transport: "auto"`)
 *   - Hibernatable WebSockets — DO evicts while idle, costs nothing
 *   - DurableObjectEventStore — Last-Event-ID replay for resumability
 *   - elicitInput() — server-initiated user prompts (MCP 2025-06-18)
 *   - sendResourceUpdated() — push to subscribed clients
 *
 * Resources, prompts, and elicitations land in subsequent commits.
 */
export class MetroMcpAgent extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: 'metro-mcp',
    version: SERVER_VERSION
  });

  async init(): Promise<void> {
    this.registerStationTools();
    this.registerIncidentTools();
    this.registerBusTools();
    this.registerTrainTools();
    this.registerRouteTools();
    this.registerResources();
  }

  // ─── Resources ─────────────────────────────────────────────────────
  /**
   * Three transit:// resource templates expose catalog data so clients
   * can read individual stations/routes/incidents by URI rather than
   * routing every query through a tool call.
   *
   * Listing is deliberately empty for stations/routes — the catalog is
   * large (~600 stations) and tool-driven discovery (search_stations,
   * get_stations_by_line) is the right entry point. Incidents return a
   * per-city URI in the list so subscribers can pick one to watch.
   *
   * resources/subscribe push notifications will land in a follow-up
   * once we add a Cron-driven incident poller (Phase 2.5). For now the
   * incident resource is read-only; clients poll.
   */
  private registerResources(): void {
    this.server.registerResource(
      'station',
      new ResourceTemplate('transit://stations/{city}/{id}', { list: undefined }),
      {
        title: 'Transit station',
        description: 'Individual transit station metadata (coordinates, lines, address).',
        mimeType: 'application/json'
      },
      async (uri, { city, id }) => {
        const cityStr = String(city);
        const idStr = String(id);
        const client = getTransitClient(cityStr as SupportedCity, this.env);
        const station = (await client.getStations()).find(s => s.id === idStr);
        if (!station) {
          throw new Error(`Station not found: ${idStr} (city: ${cityStr})`);
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({
                id: station.id,
                name: station.name,
                lines: station.lines,
                coordinates: { lat: station.latitude, lon: station.longitude },
                address: station.address ?? null,
                transfers: station.transfers ?? []
              })
            }
          ]
        };
      }
    );

    this.server.registerResource(
      'route',
      new ResourceTemplate('transit://routes/{city}/{id}', { list: undefined }),
      {
        title: 'Transit route',
        description: 'Route metadata (service patterns, descriptions). NYC routes have rich data; DC currently does not.',
        mimeType: 'application/json'
      },
      async (uri, { city, id }) => {
        const cityStr = String(city);
        const idStr = String(id);
        const client = getTransitClient(cityStr as SupportedCity, this.env);
        const route = await client.getRouteInfo(idStr);
        if (!route) {
          throw new Error(`Route not found: ${idStr} (city: ${cityStr})`);
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(route)
            }
          ]
        };
      }
    );

    this.server.registerResource(
      'incidents',
      new ResourceTemplate('transit://incidents/{city}', {
        // List the two supported per-city incident feeds so a client
        // doesn't need prior knowledge to discover them.
        list: async () => ({
          resources: [
            {
              uri: 'transit://incidents/dc',
              name: 'DC Metro incidents',
              description: 'Current service advisories for WMATA Metro.',
              mimeType: 'application/json'
            },
            {
              uri: 'transit://incidents/nyc',
              name: 'NYC Subway incidents',
              description: 'Current service advisories for MTA Subway.',
              mimeType: 'application/json'
            }
          ]
        })
      }),
      {
        title: 'Transit incidents',
        description: 'Live service advisories for a transit system. Read-only in 4.0; subscribe support arrives with the incident poller in Phase 2.5.',
        mimeType: 'application/json'
      },
      async (uri, { city }) => {
        const cityStr = String(city);
        const client = getTransitClient(cityStr as SupportedCity, this.env);
        const incidents = await client.getIncidents();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({
                city: cityStr,
                fetchedAt: new Date().toISOString(),
                incidents: incidents.map(i => ({
                  id: i.incidentId,
                  description: i.description,
                  linesAffected: i.linesAffected,
                  severity: i.severity,
                  type: i.incidentType,
                  lastUpdated: i.timestamp
                }))
              })
            }
          ]
        };
      }
    );
  }

  // ─── Station tools ─────────────────────────────────────────────────
  private registerStationTools(): void {
    this.server.registerTool(
      'get_station_predictions',
      {
        title: 'Train arrival predictions',
        description:
          'Get real-time train arrival predictions for a transit station. Supports DC Metro and NYC Subway.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {
          city: citySchema,
          stationName: z
            .string()
            .describe(
              'Station name (e.g., "Metro Center", "Times Square") — auto-converted to station ID. DC accepts codes like "A01".'
            )
        },
        outputSchema: {
          city: citySchema,
          station: z.string(),
          predictions: z.array(
            z.object({
              line: z.string(),
              destination: z.string(),
              minutesAway: z.number().int().nullable(),
              arrivalStatus: z.enum(['ARRIVING', 'BOARDING', 'DELAYED', 'SCHEDULED']),
              cars: z.string().nullable(),
              direction: z.string().nullable(),
              track: z.string().nullable()
            })
          )
        }
      },
      async ({ city, stationName }) =>
        withTransitErrors(async () => {
          const client = getTransitClient(city as SupportedCity, this.env);

          let stationId: string;
          if (/^[A-Z]\d{2}$/i.test(stationName)) {
            stationId = stationName.toUpperCase();
          } else if (/^\d+[NS]?$/.test(stationName)) {
            stationId = stationName;
          } else {
            const matches = await client.searchStation(stationName);
            if (matches.length === 0) {
              throw new Error(`No station found matching: ${stationName}`);
            }
            stationId = matches[0]!.id;
          }

          const predictions = await client.getStationPredictions(stationId);
          const statusMap: Record<string, 'ARRIVING' | 'BOARDING' | 'DELAYED'> = {
            ARR: 'ARRIVING',
            BRD: 'BOARDING',
            DLY: 'DELAYED'
          };

          const structured = {
            city,
            station: stationId,
            predictions: predictions.map(p => {
              const isNumeric = typeof p.minutesAway === 'number';
              const sentinel = typeof p.minutesAway === 'string' ? p.minutesAway.toUpperCase() : '';
              return {
                line: p.line,
                destination: p.destination,
                minutesAway: isNumeric ? (p.minutesAway as number) : null,
                arrivalStatus: isNumeric
                  ? ('SCHEDULED' as const)
                  : (statusMap[sentinel] ?? 'SCHEDULED'),
                cars: p.cars ?? null,
                direction: p.direction ?? null,
                track: p.track ?? null
              };
            })
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );

    this.server.registerTool(
      'search_stations',
      {
        title: 'Search stations',
        description: 'Search for transit stations by name or code. Supports DC Metro and NYC Subway.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {
          city: citySchema,
          query: z.string().describe('Search query (station name or code)')
        },
        outputSchema: {
          city: citySchema,
          query: z.string(),
          results: z.array(stationItemSchema)
        }
      },
      async ({ city, query }) =>
        withTransitErrors(async () => {
          const client = getTransitClient(city as SupportedCity, this.env);
          const stations = await client.searchStation(query);
          const structured = {
            city,
            query,
            results: stations.map(s => ({
              id: s.id,
              name: s.name,
              lines: s.lines,
              coordinates: { lat: s.latitude, lon: s.longitude },
              address: s.address ?? null
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );

    this.server.registerTool(
      'get_stations_by_line',
      {
        title: 'Stations on a line',
        description: 'Get all stations on a specific transit line. Supports DC Metro and NYC Subway.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {
          city: citySchema,
          lineCode: z.string().describe(
            'Line code — DC: RD, BL, YL, OR, GR, SV | NYC: 1-7, A, C, E, B, D, F, M, N, Q, R, W, J, Z, L, G, SI'
          )
        },
        outputSchema: {
          city: citySchema,
          line: z.string(),
          stations: z.array(stationItemSchema)
        }
      },
      async ({ city, lineCode }) =>
        withTransitErrors(async () => {
          const client = getTransitClient(city as SupportedCity, this.env);
          const stations = await client.getStationsByLine(lineCode);
          const structured = {
            city,
            line: lineCode,
            stations: stations.map(s => ({
              id: s.id,
              name: s.name,
              lines: s.lines,
              coordinates: { lat: s.latitude, lon: s.longitude },
              address: s.address ?? null
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );

    this.server.registerTool(
      'get_all_stations',
      {
        title: 'All stations',
        description: 'Get complete list of all transit stations with coordinates.',
        annotations: READ_ONLY_LIVE,
        inputSchema: { city: citySchema },
        outputSchema: {
          city: citySchema,
          totalStations: z.number().int(),
          stations: z.array(stationItemSchema)
        }
      },
      async ({ city }) =>
        withTransitErrors(async () => {
          const client = getTransitClient(city as SupportedCity, this.env);
          const all = await client.getStations();
          const structured = {
            city,
            totalStations: all.length,
            stations: all.map(s => ({
              id: s.id,
              name: s.name,
              lines: s.lines,
              coordinates: { lat: s.latitude, lon: s.longitude },
              address: s.address ?? null
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );

    this.server.registerTool(
      'get_station_transfers',
      {
        title: 'Station transfers',
        description:
          'Get transfer connections and nearby stations from a transit station. NYC Subway only.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {
          city: z.enum(['nyc']),
          stationId: z.string().describe('Station ID (e.g., "127" for Times Square)')
        },
        outputSchema: {
          city: z.enum(['nyc']),
          stationId: z.string(),
          stationName: z.string(),
          totalTransfers: z.number().int(),
          transfers: z.array(
            z.object({
              toStationId: z.string(),
              toStationName: z.string(),
              walkTimeSeconds: z.number().int(),
              walkTimeMinutes: z.number().int(),
              transferType: z.enum(['platform', 'nearby'])
            })
          )
        }
      },
      async ({ city, stationId }) =>
        withTransitErrors(async () => {
          const client = getTransitClient(city as SupportedCity, this.env);
          const station = (await client.getStations()).find(s => s.id === stationId);
          if (!station) {
            throw new Error(`Station not found: ${stationId}`);
          }
          const transfers = station.transfers || [];
          const structured = {
            city,
            stationId,
            stationName: station.name,
            totalTransfers: transfers.length,
            transfers: transfers.map(t => ({
              toStationId: t.toStationId,
              toStationName: t.toStationName,
              walkTimeSeconds: t.transferTime,
              walkTimeMinutes: Math.ceil(t.transferTime / 60),
              transferType: t.transferType
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );
  }

  // ─── Incident tools ────────────────────────────────────────────────
  private registerIncidentTools(): void {
    this.server.registerTool(
      'get_incidents',
      {
        title: 'Service incidents',
        description: 'Get current transit incidents and service advisories.',
        annotations: READ_ONLY_LIVE,
        inputSchema: { city: citySchema },
        outputSchema: {
          city: citySchema,
          incidents: z.array(
            z.object({
              id: z.string(),
              description: z.string(),
              linesAffected: z.array(z.string()),
              severity: z.string(),
              type: z.string(),
              lastUpdated: z.string()
            })
          )
        }
      },
      async ({ city }) =>
        withTransitErrors(async () => {
          const client = getTransitClient(city as SupportedCity, this.env);
          const incidents = await client.getIncidents();
          const structured = {
            city,
            incidents: incidents.map(i => ({
              id: i.incidentId,
              description: i.description,
              linesAffected: i.linesAffected,
              severity: i.severity,
              type: i.incidentType,
              lastUpdated: i.timestamp
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );

    this.server.registerTool(
      'get_elevator_incidents',
      {
        title: 'Elevator outages',
        description: 'Get current elevator and escalator outages. DC Metro only.',
        annotations: READ_ONLY_LIVE,
        inputSchema: { city: z.enum(['dc']) },
        outputSchema: {
          city: z.enum(['dc']),
          elevatorIncidents: z.array(
            z.object({
              id: z.string(),
              description: z.string(),
              stationName: z.string().nullable(),
              lastUpdated: z.string()
            })
          )
        }
      },
      async ({ city }) =>
        withTransitErrors(async () => {
          const client = getTransitClient(city as SupportedCity, this.env) as WMATAClient;
          const incidents = await client.getElevatorIncidents();
          const structured = {
            city,
            elevatorIncidents: incidents.map(i => ({
              id: i.incidentId,
              description: i.description,
              stationName: i.startLocation || i.endLocation || null,
              lastUpdated: i.timestamp
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );
  }

  // ─── Bus tools (DC only) ──────────────────────────────────────────
  private registerBusTools(): void {
    this.server.registerTool(
      'get_bus_predictions',
      {
        title: 'Bus arrival predictions',
        description: 'Get real-time bus arrival predictions for a DC Metro bus stop.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {
          stopId: z.string().describe('DC Metro 7-digit regional bus stop ID (e.g., "1001195")')
        },
        outputSchema: {
          city: z.literal('dc'),
          stopId: z.string(),
          predictions: z.array(
            z.object({
              route: z.string(),
              direction: z.string(),
              minutesAway: z.number().int(),
              vehicleId: z.string().nullable(),
              tripId: z.string().nullable()
            })
          )
        }
      },
      async ({ stopId }) =>
        withTransitErrors(async () => {
          const client = getTransitClient('dc', this.env) as WMATAClient;
          const predictions = await client.getBusPredictions(stopId);
          const structured = {
            city: 'dc' as const,
            stopId,
            predictions: predictions.map(p => ({
              route: p.RouteID,
              direction: p.DirectionText,
              minutesAway: p.Minutes,
              vehicleId: p.VehicleID ?? null,
              tripId: p.TripID ?? null
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );

    this.server.registerTool(
      'get_bus_routes',
      {
        title: 'All bus routes',
        description: 'Get all DC Metro bus routes with route IDs and descriptions.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {},
        outputSchema: {
          city: z.literal('dc'),
          totalRoutes: z.number().int(),
          routes: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              description: z.string().nullable()
            })
          )
        }
      },
      async () =>
        withTransitErrors(async () => {
          const client = getTransitClient('dc', this.env) as WMATAClient;
          const routes = await client.getBusRoutes();
          const structured = {
            city: 'dc' as const,
            totalRoutes: routes.length,
            routes: routes.map(r => ({
              id: r.RouteID,
              name: r.Name,
              description: r.LineDescription ?? null
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );

    this.server.registerTool(
      'get_bus_stops',
      {
        title: 'Bus stops',
        description:
          'Get DC Metro bus stops. Returns all stops or filters by lat/lon/radius.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {
          latitude: z.number().optional().describe('Center latitude for geographic search'),
          longitude: z.number().optional().describe('Center longitude for geographic search'),
          radius: z.number().optional().describe('Search radius in meters')
        },
        outputSchema: {
          city: z.literal('dc'),
          totalStops: z.number().int(),
          searchLocation: z
            .object({
              lat: z.number(),
              lon: z.number(),
              radiusMeters: z.number().nullable()
            })
            .nullable(),
          stops: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              coordinates: coordinatesSchema,
              routes: z.array(z.string())
            })
          )
        }
      },
      async ({ latitude, longitude, radius }) =>
        withTransitErrors(async () => {
          const client = getTransitClient('dc', this.env) as WMATAClient;
          const stops = await client.getBusStops(latitude, longitude, radius);
          const structured = {
            city: 'dc' as const,
            totalStops: stops.length,
            searchLocation:
              latitude !== undefined && longitude !== undefined
                ? { lat: latitude, lon: longitude, radiusMeters: radius ?? null }
                : null,
            stops: stops.map(s => ({
              id: s.StopID,
              name: s.Name,
              coordinates: { lat: s.Lat, lon: s.Lon },
              routes: s.Routes
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );

    this.server.registerTool(
      'get_bus_positions',
      {
        title: 'Live bus positions',
        description: 'Get real-time positions of DC Metro buses, optionally filtered by route.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {
          routeId: z
            .string()
            .optional()
            .describe('Optional route ID filter (e.g., "30N"). Omit for all buses.')
        },
        outputSchema: {
          city: z.literal('dc'),
          routeFilter: z.string().nullable(),
          totalBuses: z.number().int(),
          buses: z.array(
            z.object({
              vehicleId: z.string(),
              route: z.string(),
              direction: z.string(),
              coordinates: coordinatesSchema,
              headsign: z.string().nullable(),
              deviation: z.number().nullable(),
              lastUpdated: z.string()
            })
          )
        }
      },
      async ({ routeId }) =>
        withTransitErrors(async () => {
          const client = getTransitClient('dc', this.env) as WMATAClient;
          const positions = await client.getBusPositions(routeId);
          const structured = {
            city: 'dc' as const,
            routeFilter: routeId ?? null,
            totalBuses: positions.length,
            buses: positions.map(b => ({
              vehicleId: b.VehicleID,
              route: b.RouteID,
              direction: b.DirectionText,
              coordinates: { lat: b.Lat, lon: b.Lon },
              headsign: b.TripHeadsign ?? null,
              deviation: b.Deviation ?? null,
              lastUpdated: b.DateTime
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );
  }

  // ─── Train tools (DC only) ─────────────────────────────────────────
  private registerTrainTools(): void {
    this.server.registerTool(
      'get_train_positions',
      {
        title: 'Live train positions',
        description: 'Get real-time positions of all trains on the DC Metro system.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {},
        outputSchema: {
          city: z.literal('dc'),
          totalTrains: z.number().int(),
          trains: z.array(
            z.object({
              trainId: z.string(),
              trainNumber: z.string().nullable(),
              line: z.string().nullable(),
              destination: z.string().nullable(),
              carCount: z.number().int().nullable(),
              direction: z.enum(['Northbound/Eastbound', 'Southbound/Westbound']),
              circuitId: z.number().int().nullable(),
              secondsAtLocation: z.number().int().nullable(),
              serviceType: z.string().nullable()
            })
          )
        }
      },
      async () =>
        withTransitErrors(async () => {
          const client = getTransitClient('dc', this.env) as WMATAClient;
          const trains = await client.getTrainPositions();
          const structured = {
            city: 'dc' as const,
            totalTrains: trains.length,
            trains: trains.map(t => ({
              trainId: t.TrainId,
              trainNumber: t.TrainNumber ?? null,
              line: t.LineCode ?? null,
              destination: t.DestinationStationCode ?? null,
              carCount: t.CarCount ?? null,
              direction: (t.DirectionNum === 1
                ? 'Northbound/Eastbound'
                : 'Southbound/Westbound') as 'Northbound/Eastbound' | 'Southbound/Westbound',
              circuitId: t.CircuitId ?? null,
              secondsAtLocation: t.SecondsAtLocation ?? null,
              serviceType: t.ServiceType ?? null
            }))
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );
  }

  // ─── Route tools ──────────────────────────────────────────────────
  private registerRouteTools(): void {
    this.server.registerTool(
      'get_route_info',
      {
        title: 'Route information',
        description:
          'Get detailed information about a transit route including service patterns. NYC Subway only.',
        annotations: READ_ONLY_LIVE,
        inputSchema: {
          city: z.enum(['nyc']),
          routeId: z.string().describe(
            'Route identifier — NYC: A, B, C, D, E, F, M, G, J, Z, L, N, Q, R, W, 1, 2, 3, 4, 5, 6, 7, SI'
          )
        },
        outputSchema: {
          city: z.enum(['nyc']),
          routeId: z.string(),
          shortName: z.string(),
          longName: z.string(),
          description: z.string()
        }
      },
      async ({ city, routeId }) =>
        withTransitErrors(async () => {
          const client = getTransitClient(city as SupportedCity, this.env);
          const route = await client.getRouteInfo(routeId);
          if (!route) {
            throw new Error(`Route not found: ${routeId}. Make sure you're using the correct ID for ${city}.`);
          }
          const structured = {
            city,
            routeId: route.routeId,
            shortName: route.shortName,
            longName: route.longName,
            description: route.description
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
            structuredContent: structured
          };
        })
    );
  }
}
