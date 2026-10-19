import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getCoverage } from '../../../transit/core/coverage';
import { MAX_DISCOVERY_CANDIDATES, ambiguityCandidate, boundedText, candidateSchema, candidates, checkState, coordinatesSchema, coverageSchema, detail, effectiveCapabilities, entities, guarded, trainCandidates, inferCoverage, loadData, metadata, resultShape, unavailable, validRef } from './shared';

export const entitySchema = candidateSchema.extend({ scheduleVersion: z.string(), resourceUri: z.string(), coordinates: coordinatesSchema.nullable(), routeRefs: z.array(z.string()),
  agencyRef: z.string().nullable(), mode: z.string().nullable(), patterns: z.array(z.strictObject({ id: z.string(), directionId: z.number().int().nullable(), stopRefs: z.array(z.string()) })),
  calls: z.array(z.strictObject({ stopRef: z.string(), sequence: z.number().int(), arrivalSeconds: z.number().int().nullable(), departureSeconds: z.number().int().nullable(), pickupType: z.number().int(), dropOffType: z.number().int() })) });
export const findOutput = z.strictObject({ ...resultShape, coverages: z.array(z.strictObject({ id: z.string(), displayName: z.string(), aliases: z.array(z.string()), supportedModes: z.array(z.string()),
  available: z.boolean(), capabilities: z.strictObject({ schedules: z.boolean(), realtimeDepartures: z.boolean(), alerts: z.boolean(), vehicles: z.boolean(), planning: z.boolean(), accessibility: z.boolean() }) })),
  candidates: z.array(candidateSchema), entities: z.array(entitySchema), clientCoordinates: coordinatesSchema.nullable() });
export async function findEntityResult(context: MetroMcpContext, ref: string, signal: AbortSignal, version?: string) {
  const parsed = validRef(ref, ['agency', 'route', 'stop', 'trip']);
  const data = await loadData(context, parsed.coverage, signal, version);
  if (!data) return { ...unavailable(parsed.coverage), coverages: [], candidates: [], entities: [], clientCoordinates: null };
  return { ...metadata(parsed.coverage, data, data.manifest.sources[0]!.retrievedAt), status: 'scheduled_only' as const, reasons: [], coverages: [], candidates: [], entities: [await detail(data, ref)], clientCoordinates: null };
}
export function registerFindTool(server: McpServer, context: MetroMcpContext): void {
  const common = { coverage: coverageSchema.optional(), context: z.strictObject({ coverage: coverageSchema.optional(), feed: boundedText.optional(), serviceDate: z.string().regex(/^\d{8}$/).optional() }).optional(), limit: z.number().int().min(1).max(50).default(20) };
  const absent = { ref: z.never().optional(), query: z.never().optional(), latitude: z.never().optional(), longitude: z.never().optional() };
  server.registerTool('find_transit', {
    title: 'Find transit entities', description: 'Resolve a coverage, agency, route, station, stop, or a currently observed train number (where vehicle data exists); inspect an exact reference or nearby coordinates. Context ranks candidates without selecting identity. No general address geocoding. Use plan_trip for journeys.',
    annotations: readOnlyLive('Find transit entities'),
    inputSchema: z.union([z.strictObject({ ...common, ...absent, ref: boundedText }), z.strictObject({ ...common, ...absent, query: boundedText }),
      z.strictObject({ ...common, ...absent, latitude: coordinatesSchema.shape.latitude, longitude: coordinatesSchema.shape.longitude })]),
    outputSchema: findOutput,
  }, async (args, handler) => {
    let resolvedCoverage = args.coverage;
    return guarded(handler, async () => {
      checkState(handler, 'find_transit');
      if (args.ref) return complete(await findEntityResult(context, args.ref, handler.mcpReq.signal));
      const match = args.query ? getCoverage(args.query) : undefined;
      const coordinateCoverage = args.latitude === undefined ? undefined : inferCoverage({ latitude: args.latitude, longitude: args.longitude! });
      // An exact coverage query identifies the coverage being inspected; a name-search
      // scope must not lend another coverage's availability or provenance to it.
      const id = match?.id ?? getCoverage(args.coverage ?? '')?.id ?? args.coverage ?? coordinateCoverage ?? 'sfbay';
      resolvedCoverage = id;
      const data = await loadData(context, id, handler.mcpReq.signal);
      const base = { ...(data ? { ...metadata(id, data), status: 'scheduled_only' as const, reasons: [] } : unavailable(id)),
        coverages: match ? [{ id: match.id, displayName: match.displayName, aliases: [...match.aliases], supportedModes: [...match.supportedModes], available: Boolean(data), capabilities: effectiveCapabilities(context, match) }] : [],
        entities: [], clientCoordinates: args.latitude === undefined ? null : { latitude: args.latitude, longitude: args.longitude! } };
      let found = data && !match ? args.query ? candidates(data, args.query) : entities(data).filter(entity => entity.kind === 'stop') : [];
      const trains = data && !match && args.query ? await trainCandidates(context, data, args.query, handler.mcpReq.signal) : { candidates: [], sources: [] };
      if (trains.candidates.length) {
        base.sources.push(...trains.sources);
        // Every train carrying this number is a candidate; identity is never chosen here.
        return complete({ ...base, candidates: [...trains.candidates, ...found.filter(entity => !trains.candidates.some(train => train.ref === entity.ref))].slice(0, Math.max(args.limit, trains.candidates.length)) });
      }
      if (args.latitude !== undefined && data) {
        const latitude = args.latitude, longitude = args.longitude!;
        const distance = (ref: string) => { const stop = data.indexes.flatMap(index => index.stops).find(stop => stop.ref === ref); return stop?.latitude != null && stop.longitude != null ? Math.hypot(stop.latitude - latitude, (stop.longitude - longitude) * Math.cos(latitude * Math.PI / 180)) : Infinity; };
        found = found.filter(entity => distance(entity.ref) <= 0.02).sort((a, b) => distance(a.ref) - distance(b.ref) || a.ref.localeCompare(b.ref));
      }
      if (args.context) found.sort((a, b) => Number(b.coverage === args.context?.coverage) + Number(b.feed === args.context?.feed) - Number(a.coverage === args.context?.coverage) - Number(a.feed === args.context?.feed));
      const ambiguous = args.query && data ? found.filter(candidate => ambiguityCandidate(data, candidate, args.query!)) : [];
      if (ambiguous.length > MAX_DISCOVERY_CANDIDATES) return complete({ ...base, status: 'unavailable' as const, reasons: ['SCOPE_LIMIT_EXCEEDED' as const], candidates: [] });
      // Preserve material alternatives in their existing rank, including named place stops.
      return complete({ ...base, candidates: ambiguous.length > 1 ? ambiguous : found.slice(0, args.limit) });
    }, () => complete({ ...unavailable(resolvedCoverage), coverages: [], candidates: [], entities: [], clientCoordinates: null }));
  });
}
