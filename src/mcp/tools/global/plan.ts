import { CLIENT_CAPABILITIES_META_KEY, ProtocolError, ProtocolErrorCode, acceptedContent, inputRequired, inputResponse, type McpServer, type RequestStateCodec } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext, TransitRequestState } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getCoverage } from '../../../transit/core/coverage';
import { planJourney } from '../../../transit/planner/plan';
import type { JourneyEndpoint } from '../../../transit/planner/types';
import type { NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { canonicalJson, decodeScheduleShard, sha256 } from '../../../transit/gtfs/static/shards';
import { MAX_DISCOVERY_CANDIDATES, TransitToolError, asTransitRef, candidates, checkState, coordinatesSchema, coverageSchema, endpointSchema, guarded, inferCoverage, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, sourceSchema, unavailable, type Candidate } from './shared';

const journeyEndpoint = z.union([z.string(), coordinatesSchema]);
const transitLeg = z.strictObject({ kind: z.literal('transit'), from: z.string(), to: z.string(), tripRef: z.string(), tripInstanceRef: z.string(), serviceDate: z.string(), instanceStartSeconds: z.number(),
  routeRef: z.string(), directionId: z.number().int().nullable(), headsign: z.string(), boardSequence: z.number().int(), alightSequence: z.number().int(), scheduleVersion: z.string(),
  scheduledDepartureTime: instantSchema, scheduledArrivalTime: instantSchema, departureTime: instantSchema, arrivalTime: instantSchema, status: z.enum(['realtime', 'scheduled_only']),
  realtimeTimestampSeconds: z.number().optional(), continuation: z.boolean(), mode: z.string(), agencyRef: z.string(), intermediateStopCount: z.number().int().nonnegative(),
  transferRequired: z.boolean(), sources: z.array(sourceSchema), validatorOutcome: z.literal('valid') });
const walkLeg = z.strictObject({ kind: z.literal('walk'), from: journeyEndpoint, to: journeyEndpoint, departureTime: instantSchema, arrivalTime: instantSchema, distanceMetres: z.number(),
  verification: z.enum(['pathway', 'unverified']), estimated: z.boolean(), pathwayId: z.string().optional(), validatorOutcome: z.literal('valid') });
export const itinerarySchema = z.strictObject({ coverageId: z.string(), artifactVersion: z.string(), origin: journeyEndpoint, destination: journeyEndpoint, departAt: instantSchema, windowSeconds: z.number().int(),
  maxWalkMetres: z.number(), maxTransfers: z.number().int(), departureTime: instantSchema, arrivalTime: instantSchema, walkingMetres: z.number(), transfers: z.number().int(),
  status: z.enum(['realtime', 'scheduled_only']), legs: z.array(z.union([transitLeg, walkLeg])) });

export const planInput = z.strictObject({ origin: endpointSchema, destination: endpointSchema, coverage: coverageSchema.optional(), departAt: instantSchema.optional(),
  windowSeconds: z.number().int().min(1).max(604800).default(7200), maxWalkMetres: z.number().min(0).max(800).default(800), maxTransfers: z.number().int().min(0).max(4).default(3),
  accessibility: z.enum(['no_preference', 'step_free']).default('no_preference') });
export const planState = z.strictObject({ phase: z.literal('transit-selection'), tool: z.literal('plan_trip'), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  artifactVersion: z.string().regex(/^[a-f0-9]{64}$/),
  candidates: z.strictObject({ origin: z.array(z.string()).min(2).max(MAX_DISCOVERY_CANDIDATES).optional(), destination: z.array(z.string()).min(2).max(MAX_DISCOVERY_CANDIDATES).optional() }) });
export const planRequestHash = async (args: unknown) => sha256(new TextEncoder().encode(canonicalJson(planInput.parse(args))));
export function verifyPlanChoices(state: z.infer<typeof planState>, inputResponses: unknown): void {
  const response = z.object({ endpoints: z.object({ action: z.enum(['accept', 'decline', 'cancel']), content: z.strictObject({ origin: z.string().optional(), destination: z.string().optional() }).optional() }) }).parse(inputResponses).endpoints;
  if (response.action !== 'accept') return;
  for (const endpoint of ['origin', 'destination'] as const) {
    if (state.candidates[endpoint] && (!response.content?.[endpoint] || !state.candidates[endpoint]!.includes(response.content[endpoint]!))) throw new Error('Invalid transit entity selection');
    if (!state.candidates[endpoint] && response.content?.[endpoint]) throw new Error('Unexpected transit entity selection');
  }
}

export function registerPlanTool(server: McpServer, context: MetroMcpContext, codec: RequestStateCodec<TransitRequestState>): void {
  server.registerTool('plan_trip', {
    title: 'Plan a transit journey', description: 'Plan an origin-to-destination journey when find_transit reports available coverage with planning enabled. Returns up to three independently validated itineraries and resolves named endpoints together; departure defaults to now. Never assemble or repair journeys from get_departures.',
    annotations: readOnlyLive('Plan a transit journey'),
    inputSchema: planInput,
    outputSchema: z.strictObject({ ...resultShape, itineraries: z.array(itinerarySchema).max(3) }),
  }, async (args, handler) => guarded(handler, async () => {
    const state = checkState(handler, 'plan_trip');
    const requestHash = await planRequestHash(args);
    if (state && (state.phase !== 'transit-selection' || state.tool !== 'plan_trip' || state.requestHash !== requestHash)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Transit selection state does not match this request');
    const originCoverage = inferCoverage(args.origin), destinationCoverage = inferCoverage(args.destination);
    const coverageId = originCoverage ?? destinationCoverage ?? getCoverage(args.coverage ?? '')?.id ?? args.coverage;
    const noData = () => complete({ ...unavailable(coverageId), itineraries: [] });
    if (!coverageId || originCoverage && destinationCoverage && originCoverage !== destinationCoverage) return noData();
    const data = await loadData(context, coverageId, handler.mcpReq.signal, state?.phase === 'transit-selection' ? state.artifactVersion : undefined);
    if (!data) return noData();
    // This planner has no verified step-free constraints yet; never imply accessibility.
    if (args.accessibility === 'step_free') return complete({ ...unavailable(coverageId, data), itineraries: [] });
    const resolved: Partial<Record<'origin' | 'destination', JourneyEndpoint>> = {};
    const ambiguous: Partial<Record<'origin' | 'destination', Candidate[]>> = {};
    const accepted = state?.phase === 'transit-selection' ? acceptedContent(handler.mcpReq.inputResponses, 'endpoints', z.strictObject({ origin: z.string().optional(), destination: z.string().optional() })) : undefined;
    for (const endpoint of ['origin', 'destination'] as const) {
      if (state?.phase === 'transit-selection' && state.candidates[endpoint]) {
        if (!accepted?.[endpoint]) throw new TransitToolError('SELECTION_DECLINED');
        knownEntity(data, accepted[endpoint]!); resolved[endpoint] = asTransitRef(accepted[endpoint]!); continue;
      }
      const value = args[endpoint];
      if ('ref' in value) { knownEntity(data, value.ref); resolved[endpoint] = asTransitRef(value.ref); }
      else if ('latitude' in value) resolved[endpoint] = value;
      else {
        const matches = candidates(data, value.query, 'stop');
        if (matches.length > MAX_DISCOVERY_CANDIDATES) return complete({ ...unavailable(coverageId, data, ['SCOPE_LIMIT_EXCEEDED']), itineraries: [] });
        if (!matches.length) throw new TransitToolError('ENTITY_NOT_FOUND');
        if (matches.length === 1) resolved[endpoint] = asTransitRef(matches[0]!.ref);
        else ambiguous[endpoint] = matches.map(candidate => ({ ...candidate, endpoint }));
      }
    }
    if (state?.phase === 'transit-selection') {
      const response = inputResponse(handler.mcpReq.inputResponses, 'endpoints');
      if (response.kind === 'elicit' && response.action !== 'accept') throw new TransitToolError('SELECTION_DECLINED');
    } else if (Object.keys(ambiguous).length) {
      // SDK 2.3 exposes this runtime envelope but currently types it as {}.
      const declared = (handler.mcpReq.envelope as Record<string, { elicitation?: { form?: unknown; url?: unknown } }> | undefined)?.[CLIENT_CAPABILITIES_META_KEY];
      if (context.era !== 'modern' || !declared?.elicitation || (declared.elicitation.form === undefined && Object.keys(declared.elicitation).length > 0)) throw new TransitToolError('ENTITY_AMBIGUOUS', Object.values(ambiguous).flat());
      const choices: Partial<Record<'origin' | 'destination', string[]>> = {};
      const shape: Record<string, z.ZodEnum<Record<string, string>>> = {};
      for (const endpoint of ['origin', 'destination'] as const) {
        const matches = ambiguous[endpoint]; if (!matches) continue;
        choices[endpoint] = matches.map(candidate => candidate.ref);
        shape[endpoint] = z.enum(choices[endpoint] as [string, ...string[]]).describe(matches.map(candidate => `${candidate.ref} (${candidate.coverage}/${candidate.feed}): ${candidate.name}`).join('; '));
      }
      return inputRequired({ inputRequests: { endpoints: inputRequired.elicit({ message: 'Choose the transit endpoints for this journey.', requestedSchema: z.object(shape) }) },
        requestState: await codec.mint({ phase: 'transit-selection', tool: 'plan_trip', requestHash, artifactVersion: data.version.artifactVersion, candidates: choices }, handler) });
    }
    const now = new Date().toISOString(), feed = await readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', Date.parse(now) / 1000, handler.mcpReq.signal);
    if (feed.payload?.some(update => ['ADDED', 'DUPLICATED', 'REPLACEMENT'].includes(update.scheduleRelationship ?? ''))) {
      return complete({ ...unavailable(coverageId, data, ['REALTIME_UNAVAILABLE']), sources: [...metadata(coverageId, data).sources, ...realtimeSource(data, feed, 'trip_updates', Date.parse(now) / 1000)], itineraries: [] });
    }
    const sequences = new Map<string, number[]>();
    const result = await planJourney({ manifest: data.manifest, readShard: async key => {
      const bytes = await data.readObject(key), shard = decodeScheduleShard(bytes);
      for (const trip of shard.trips) sequences.set(trip.ref, trip.stopTimes.map(call => call.sequence));
      return bytes;
    }, origin: resolved.origin!, destination: resolved.destination!, departAt: args.departAt ?? now, now,
      windowSeconds: args.windowSeconds, maxWalkMetres: args.maxWalkMetres, maxTransfers: args.maxTransfers, realtimeMaxAgeSeconds: data.coverage.thresholds.tripUpdates.realtimeSeconds,
      realtime: feed.payload !== null && feed.version && feed.receivedAtSeconds !== undefined ? { ...feed, version: feed.version, receivedAtSeconds: feed.receivedAtSeconds } : undefined }, handler.mcpReq.signal);
    const meta = metadata(coverageId, data, now);
    if (feed) meta.sources.push(...realtimeSource(data, feed, 'trip_updates', Date.parse(now) / 1000));
    const routes = data.indexes.flatMap(index => index.routes);
    return complete({ ...meta, status: result.status, reasons: [...new Set([...result.reasons, ...feed.reasons])], itineraries: result.candidates.map(candidate => ({ ...candidate, legs: candidate.legs.map((leg, index) => {
      if (leg.kind === 'walk') return { ...leg, validatorOutcome: 'valid' as const };
      const route = routes.find(route => route.ref === leg.routeRef)!;
      return { ...leg, mode: route.mode, agencyRef: route.agencyRef, intermediateStopCount: (sequences.get(leg.tripRef) ?? []).filter(sequence => sequence > leg.boardSequence && sequence < leg.alightSequence).length,
        transferRequired: candidate.legs.slice(0, index).some(prior => prior.kind === 'transit') && !leg.continuation, sources: meta.sources.filter(source => source.scheduleVersion === leg.scheduleVersion), validatorOutcome: 'valid' as const };
    }) })) });
  }, () => complete({ ...unavailable(args.coverage), itineraries: [] })));
}
