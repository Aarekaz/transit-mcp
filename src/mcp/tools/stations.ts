import {
  ProtocolError,
  ProtocolErrorCode,
  acceptedContent,
  inputRequired,
  inputResponse,
  type McpServer,
  type RequestStateCodec,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { formatStationPredictionsForMcp } from '../prediction-format';
import { getTransitClient } from '../../transit/registry';
import type { SupportedCity, TransitStation } from '../../transit/base';
import type { MetroMcpContext, MetroRequestState } from '../context';
import { TRANSIT_BOARD_TOOL_META } from '../apps';
import {
  READ_ONLY_LIVE,
  citySchema,
  complete,
  stationItemSchema,
  toolError,
  withTransitErrors,
} from '../shared';

const stationChoiceSchema = z.object({ stationId: z.string().min(1) });

function stationItem(station: TransitStation) {
  return {
    id: station.id,
    name: station.name,
    lines: station.lines,
    coordinates: { lat: station.latitude, lon: station.longitude },
    address: station.address ?? null,
  };
}

function normalizeStationQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasUniqueCandidateIds(matches: TransitStation[]): boolean {
  return new Set(matches.map(match => match.id)).size === matches.length;
}

function hasValidCandidateIds(state: MetroRequestState): boolean {
  return Array.isArray(state.candidateIds)
    && state.candidateIds.length > 0
    && state.candidateIds.every(candidateId => (
      typeof candidateId === 'string' && candidateId.length > 0
    ))
    && new Set(state.candidateIds).size === state.candidateIds.length;
}

function ambiguousStationRetry(matches: TransitStation[]) {
  const candidates = matches
    .map(match => `${match.id} — ${match.name}`)
    .join('; ');
  return toolError(
    `Multiple stations match this query: ${candidates}; please call get_station_predictions again with an exact station ID.`,
  );
}

/** Register the five station tools in their wire-visible order. */
export function registerStationTools(
  server: McpServer,
  context: MetroMcpContext,
  stateCodec: RequestStateCodec<MetroRequestState>,
): void {
  server.registerTool(
    'get_station_predictions',
    {
      title: 'Train arrival predictions',
      description:
        'Get real-time train arrival predictions for a transit station. Supports DC Metro and NYC Subway.',
      annotations: READ_ONLY_LIVE,
      _meta: TRANSIT_BOARD_TOOL_META,
      inputSchema: z.object({
        city: citySchema,
        stationName: z.string().describe(
          'Station name (e.g., "Metro Center", "Times Square") — auto-converted to station ID. DC accepts codes like "A01".',
        ),
      }),
      outputSchema: z.object({
        city: citySchema,
        station: z.string(),
        predictions: z.array(z.object({
          line: z.string(),
          destination: z.string(),
          minutesAway: z.number().int().nullable(),
          arrivalTime: z.string().nullable(),
          arrivalStatus: z.enum(['ARRIVING', 'BOARDING', 'DELAYED', 'SCHEDULED']),
          cars: z.string().nullable(),
          direction: z.string().nullable(),
          track: z.string().nullable(),
        })),
      }),
    },
    async ({ city, stationName }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const client = getTransitClient(city as SupportedCity, context.env);
      const state = handlerContext.mcpReq.requestState<MetroRequestState>();
      let stationId: string;

      if (state !== undefined) {
        if (
          state.phase !== 'station-selection'
          || state.tool !== 'get_station_predictions'
          || state.city !== city
          || state.query !== normalizeStationQuery(stationName)
          || !hasValidCandidateIds(state)
        ) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            'Station selection state does not match this request',
          );
        }

        const response = inputResponse(handlerContext.mcpReq.inputResponses, 'station');
        if (response.kind === 'elicit' && response.action !== 'accept') {
          const outcome = response.action === 'decline' ? 'declined' : 'cancelled';
          return toolError(`Station selection ${outcome} by user`);
        }

        const accepted = acceptedContent(
          handlerContext.mcpReq.inputResponses,
          'station',
          stationChoiceSchema,
        );
        if (!accepted || !state.candidateIds.includes(accepted.stationId)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            'Invalid station selection',
          );
        }
        stationId = accepted.stationId;
      } else if (/^[A-Z]\d{2}$/i.test(stationName)) {
        stationId = stationName.toUpperCase();
      } else if (/^\d+[NS]?$/.test(stationName)) {
        stationId = stationName;
      } else {
        const matches = await client.searchStation(stationName, signal);
        if (matches.length === 0) {
          throw new Error(`No station found matching: ${stationName}`);
        }

        if (matches.length === 1) {
          stationId = matches[0]!.id;
        } else {
          if (!hasUniqueCandidateIds(matches)) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              'Ambiguous station matches contain duplicate candidate IDs',
            );
          }
          if (context.era === 'legacy') {
            return ambiguousStationRetry(matches);
          }

          const candidateIds = matches.map(match => match.id);
          return inputRequired({
            inputRequests: {
              station: inputRequired.elicit({
                message: `Multiple stations match "${stationName}". Choose one.`,
                requestedSchema: z.object({
                  stationId: z.enum(candidateIds as [string, ...string[]]).describe(
                    matches.map(match => `${match.id} — ${match.name}`).join('; '),
                  ),
                }),
              }),
            },
            requestState: await stateCodec.mint({
              phase: 'station-selection',
              tool: 'get_station_predictions',
              city,
              query: normalizeStationQuery(stationName),
              candidateIds,
            }, handlerContext),
          });
        }
      }

      const structured = {
        city,
        station: stationId,
        predictions: formatStationPredictionsForMcp(
          await client.getStationPredictions(stationId, signal),
        ),
      };
      return complete(structured);
    }, handlerContext.mcpReq.signal),
  );

  server.registerTool(
    'search_stations',
    {
      title: 'Search stations',
      description: 'Search for transit stations by name or code. Supports DC Metro and NYC Subway.',
      annotations: READ_ONLY_LIVE,
      _meta: TRANSIT_BOARD_TOOL_META,
      inputSchema: z.object({
        city: citySchema,
        query: z.string().describe('Search query (station name or code)'),
      }),
      outputSchema: z.object({
        city: citySchema,
        query: z.string(),
        results: z.array(stationItemSchema),
      }),
    },
    async ({ city, query }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const stations = await getTransitClient(
        city as SupportedCity,
        context.env,
      ).searchStation(query, signal);
      return complete({
        city,
        query,
        results: stations.map(stationItem),
      });
    }, handlerContext.mcpReq.signal),
  );

  server.registerTool(
    'get_stations_by_line',
    {
      title: 'Stations on a line',
      description: 'Get all stations on a specific transit line. Supports DC Metro and NYC Subway.',
      annotations: READ_ONLY_LIVE,
      _meta: TRANSIT_BOARD_TOOL_META,
      inputSchema: z.object({
        city: citySchema,
        lineCode: z.string().describe(
          'Line code — DC: RD, BL, YL, OR, GR, SV | NYC: 1-7, A, C, E, B, D, F, M, N, Q, R, W, J, Z, L, G, SI',
        ),
      }),
      outputSchema: z.object({
        city: citySchema,
        line: z.string(),
        stations: z.array(stationItemSchema),
      }),
    },
    async ({ city, lineCode }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const stations = await getTransitClient(
        city as SupportedCity,
        context.env,
      ).getStationsByLine(lineCode, signal);
      return complete({
        city,
        line: lineCode,
        stations: stations.map(stationItem),
      });
    }, handlerContext.mcpReq.signal),
  );

  server.registerTool(
    'get_all_stations',
    {
      title: 'All stations',
      description: 'Get complete list of all transit stations with coordinates.',
      annotations: READ_ONLY_LIVE,
      _meta: TRANSIT_BOARD_TOOL_META,
      inputSchema: z.object({ city: citySchema }),
      outputSchema: z.object({
        city: citySchema,
        totalStations: z.number().int(),
        stations: z.array(stationItemSchema),
      }),
    },
    async ({ city }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const progressToken = handlerContext.mcpReq._meta?.progressToken;
      const reportProgress = async (
        progress: number,
        message: string,
      ): Promise<void> => {
        if (progressToken !== undefined) {
          await handlerContext.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken, progress, total: 2, message },
          });
        }
      };

      signal.throwIfAborted();
      await reportProgress(0, `Fetching ${city.toUpperCase()} stations…`);
      signal.throwIfAborted();
      const all = await getTransitClient(
        city as SupportedCity,
        context.env,
      ).getStations(signal);
      signal.throwIfAborted();
      await reportProgress(1, `Normalizing ${all.length} stations…`);
      signal.throwIfAborted();

      return complete({
        city,
        totalStations: all.length,
        stations: all.map(stationItem),
      });
    }, handlerContext.mcpReq.signal),
  );

  server.registerTool(
    'get_station_transfers',
    {
      title: 'Station transfers',
      description:
        'Get transfer connections and nearby stations from a transit station. NYC Subway only.',
      annotations: READ_ONLY_LIVE,
      _meta: TRANSIT_BOARD_TOOL_META,
      inputSchema: z.object({
        city: z.enum(['nyc']),
        stationId: z.string().describe('Station ID (e.g., "127" for Times Square)'),
      }),
      outputSchema: z.object({
        city: z.enum(['nyc']),
        stationId: z.string(),
        stationName: z.string(),
        totalTransfers: z.number().int(),
        transfers: z.array(z.object({
          toStationId: z.string(),
          toStationName: z.string(),
          walkTimeSeconds: z.number().int(),
          walkTimeMinutes: z.number().int(),
          transferType: z.enum(['platform', 'nearby']),
        })),
      }),
    },
    async ({ city, stationId }, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const station = (await getTransitClient(
        city as SupportedCity,
        context.env,
      ).getStations(signal)).find(candidate => candidate.id === stationId);
      if (!station) {
        throw new Error(`Station not found: ${stationId}`);
      }

      const transfers = station.transfers ?? [];
      return complete({
        city,
        stationId,
        stationName: station.name,
        totalTransfers: transfers.length,
        transfers: transfers.map(transfer => ({
          toStationId: transfer.toStationId,
          toStationName: transfer.toStationName,
          walkTimeSeconds: transfer.transferTime,
          walkTimeMinutes: Math.ceil(transfer.transferTime / 60),
          transferType: transfer.transferType,
        })),
      });
    }, handlerContext.mcpReq.signal),
  );
}
