import { CLIENT_CAPABILITIES_META_KEY, ProtocolError, ProtocolErrorCode, acceptedContent, inputRequired, inputResponse, type McpServer, type RequestStateCodec } from '@modelcontextprotocol/server';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { z } from 'zod';
import { traced } from '../../../transit/trace';
import type { MetroMcpContext, TransitRequestState } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getCoverage, planningFeedIds } from '../../../transit/core/coverage';
import { parseTransitRef } from '../../../transit/core/refs';
import { planJourney } from '../../../transit/planner/plan';
import type { JourneyEndpoint } from '../../../transit/planner/types';
import type { TransitRef } from '../../../transit/core/refs';
import type { SourceStatus, VerificationReason } from '../../../transit/core/results';
import type { NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { canonicalJson, sha256 } from '../../../transit/gtfs/static/shards';
import { DecodedShardCache } from '../../../transit/planner/schedule-index';
import { MAX_DISCOVERY_CANDIDATES, TransitToolError, asTransitRef, boundedText, routeHints, routeHintsSchema, routeName, effectiveCapabilities, journeyAgencies, validRef, checkState, coordinatesSchema, coverageSchema, endpointSchema, guarded, inferCoverage, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, stopMatches, scheduledRealtimeRows, sourceSchema, stepFreeAccess, unavailable, type Candidate } from './shared';

const journeyEndpoint = z.union([z.string(), coordinatesSchema]);
const transitLeg = z.strictObject({ kind: z.literal('transit'), from: z.string(), to: z.string(), tripRef: z.string(), tripInstanceRef: z.string(), serviceDate: z.string(), instanceStartSeconds: z.number(),
  routeRef: z.string(), directionId: z.number().int().nullable(), headsign: z.string(), boardSequence: z.number().int(), alightSequence: z.number().int(), scheduleVersion: z.string(),
  scheduledDepartureTime: instantSchema, scheduledArrivalTime: instantSchema, departureTime: instantSchema, arrivalTime: instantSchema, status: z.enum(['realtime', 'scheduled_only']),
  realtimeTimestampSeconds: z.number().optional(), continuation: z.boolean(), mode: z.string(), agencyRef: z.string(), intermediateStopCount: z.number().int().nonnegative(),
  transferRequired: z.boolean(), sources: z.array(sourceSchema), validatorOutcome: z.literal('valid') });
const walkLeg = z.strictObject({ kind: z.literal('walk'), from: journeyEndpoint, to: journeyEndpoint, departureTime: instantSchema, arrivalTime: instantSchema, distanceMetres: z.number(),
  verification: z.enum(['pathway', 'unverified']), estimated: z.boolean(), pathwayId: z.string().optional(), validatorOutcome: z.literal('valid') });
/** The rider's view of an itinerary: consecutive walks (station walkways, street) merged, every
 * stop and line named. `legs` stay exact for rechecking with get_service_status. */
const stepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('walk'), fromName: z.string().nullable(), toName: z.string().nullable(), departureTime: instantSchema, arrivalTime: instantSchema,
    distanceMetres: z.number().nonnegative(), minutes: z.number().int().nonnegative(), throughStation: z.boolean().describe('Includes walkways inside a station (published pathways).') }),
  z.strictObject({ kind: z.literal('ride'), routeName: z.string(), headsign: z.string(), mode: z.string(), fromName: z.string(), toName: z.string(), departureTime: instantSchema, arrivalTime: instantSchema,
    status: z.enum(['realtime', 'scheduled_only']), intermediateStopCount: z.number().int().nonnegative(), tripInstanceRef: z.string() }),
]).describe('fromName/toName null means the caller\'s own map point.');
export const itinerarySchema = z.strictObject({ coverageId: z.string(), artifactVersion: z.string(), origin: journeyEndpoint, destination: journeyEndpoint, departAt: instantSchema, windowSeconds: z.number().int(),
  maxWalkMetres: z.number(), maxTransfers: z.number().int(), departureTime: instantSchema, arrivalTime: instantSchema, walkingMetres: z.number(), transfers: z.number().int(),
  status: z.enum(['realtime', 'scheduled_only']), legs: z.array(z.union([transitLeg, walkLeg])), steps: z.array(stepSchema).optional() });

export const planInput = z.strictObject({ origin: endpointSchema, destination: endpointSchema, coverage: coverageSchema.optional(), departAt: instantSchema.optional(),
  windowSeconds: z.number().int().min(1).max(604800).default(7200), maxWalkMetres: z.number().min(0).max(800).default(800), maxTransfers: z.number().int().min(0).max(4).default(3),
  accessibility: z.enum(['no_preference', 'step_free']).default('no_preference').describe('step_free: only platforms reachable without stairs, avoiding current elevator outages.'),
  routes: z.array(boundedText).min(1).max(4).optional().describe('Route refs (from find_transit) the journey may ride, e.g. the lines you would take: BART from SFO, then a Muni line. The server finds the actual trips, boarding stops, transfers and walks on only these routes and validates them. Works where full search is unavailable (SF Bay) and for buses.') });
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
    title: 'Plan a transit journey', description: 'Plan an origin-to-destination journey. Returns up to three independently validated itineraries and resolves named endpoints together; departure defaults to now. When no itinerary is possible (planning withheld, as in SF Bay; a search too large; or nothing found, such as a bus trip) it returns routeHints: lines near each end and direct lines serving both. Call again with routes (the lines you would ride, from routeHints or your own knowledge) to plan along only those lines, which works wherever schedules exist. Present only returned itineraries as confirmed. The whole journey must finish within windowSeconds (default two hours): if none is found for a long trip, retry with a larger window. Each transit leg carries a tripInstanceRef; pass it to get_vehicle_status to see where that train is now. For a wheelchair user or anyone avoiding stairs, set accessibility: "step_free": journeys then board, alight and change only at platforms step-free from the street per the agency (partial stations by direction), avoiding stations cut off by a current elevator outage; in-station changes between such platforms are taken as step-free. It refuses with ACCESSIBILITY_UNAVAILABLE when no current elevator report exists and ENDPOINT_NOT_STEP_FREE when an endpoint has no step-free platform now (get_service_status lists the outages). Never present a journey pieced together from get_departures as confirmed; check it here with routes.',
    annotations: readOnlyLive('Plan a transit journey'),
    inputSchema: planInput,
    outputSchema: z.strictObject({ ...resultShape, itineraries: z.array(itinerarySchema).max(3), routeHints: routeHintsSchema.optional() }),
  }, async (args, handler) => guarded(handler, () => traced('plan_trip', async () => {
    const state = checkState(handler, 'plan_trip');
    const requestHash = await planRequestHash(args);
    if (state && (state.phase !== 'transit-selection' || state.tool !== 'plan_trip' || state.requestHash !== requestHash)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Transit selection state does not match this request');
    const originCoverage = inferCoverage(args.origin), destinationCoverage = inferCoverage(args.destination);
    const coverageId = originCoverage ?? destinationCoverage ?? getCoverage(args.coverage ?? '')?.id ?? args.coverage;
    const noData = () => complete({ ...unavailable(coverageId), itineraries: [] });
    if (!coverageId || originCoverage && destinationCoverage && originCoverage !== destinationCoverage) return noData();
    const data = await loadData(context, coverageId, handler.mcpReq.signal, state?.phase === 'transit-selection' ? state.artifactVersion : undefined);
    if (!data) return noData();
    // Proposed routes keep the search to a few lines, so it runs even where an open
    // search is withheld (SF Bay) and on feeds too large to search whole (buses).
    const viaRoutes = args.routes?.map(ref => {
      const parsed = validRef(ref, ['route']);
      if (parsed.coverage !== coverageId) throw new TransitToolError('INVALID_TRANSIT_REF');
      knownEntity(data, ref);
      return asTransitRef(ref);
    });
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
        const matches = stopMatches(data, value.query);
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
        shape[endpoint] = z.enum(choices[endpoint] as [string, ...string[]]).describe(matches.map(candidate => `${candidate.ref} (${candidate.coverage}/${candidate.feed}): ${candidate.name}${candidate.stopType ? ` [${candidate.stopType}${candidate.routeNames?.length ? `: ${candidate.routeNames.join(', ')}` : ''}]` : ''}`).join('; '));
      }
      return inputRequired({ inputRequests: { endpoints: inputRequired.elicit({ message: 'Choose the transit endpoints for this journey.', requestedSchema: z.object(shape) }) },
        requestState: await codec.mint({ phase: 'transit-selection', tool: 'plan_trip', requestHash, artifactVersion: data.version.artifactVersion, candidates: choices }, handler) });
    }
    // Without an itinerary, say which lines could carry the journey so the model can propose them.
    const walkMetres = Math.min(800, args.maxWalkMetres ?? 800);
    const hinted = (reasons: VerificationReason[]) => complete({ ...unavailable(coverageId, data, reasons), itineraries: [], routeHints: routeHints(data, resolved.origin!, resolved.destination!, walkMetres) });
    if (!viaRoutes && !effectiveCapabilities(context, data.coverage, false).planning) return hinted(['PLANNING_UNAVAILABLE']);
    // Only the published feeds a journey can ride: a bus feed's state says nothing about a rail plan.
    const planning = (viaRoutes ? [...new Set(viaRoutes.map(ref => parseTransitRef(ref)!.feed))] : planningFeedIds(data.coverage)).filter(feedId => data.version.sourceVersions[feedId] !== undefined);
    // Named lines need only their own stops' predictions, not a whole region's feed. A hub
    // filters at most 200 stops; beyond that read everything rather than drop rows.
    const routeStops = viaRoutes && new Set(data.indexes.flatMap(index => Object.entries(index.stopRoutes).filter(([, refs]) => refs.some(ref => viaRoutes.includes(ref))).map(([ref]) => ref)));
    const routeStopIds = routeStops && [...new Set(data.indexes.flatMap(index => index.stops).filter(stop => routeStops.has(stop.ref)).map(stop => stop.providerId))];
    const now = new Date().toISOString(), feed = await readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', Date.parse(now) / 1000, handler.mcpReq.signal,
      routeStopIds && routeStopIds.length <= 200 ? routeStopIds : [], planning);
    // Step-free: board, alight and change only where access is step-free now. Without a
    // current equipment report, or with an endpoint cut off, refuse rather than guess.
    let stepFree: { usableStopRefs: ReadonlySet<TransitRef> } | undefined, accessSources: SourceStatus[] = [];
    if (args.accessibility === 'step_free') {
      const access = await stepFreeAccess(context, data, Date.parse(now) / 1000, handler.mcpReq.signal);
      accessSources = access.sources;
      const refuse = (reasons: VerificationReason[]) => complete({ ...unavailable(coverageId, data, reasons), sources: [...metadata(coverageId, data).sources, ...accessSources], itineraries: [] });
      if (!access.usable) return refuse(access.reasons);
      const stops = data.indexes.flatMap(index => index.stops);
      for (const endpoint of [resolved.origin!, resolved.destination!]) {
        if (typeof endpoint === 'string' && !stops.some(stop => (stop.ref === endpoint || stop.parentStationRef === endpoint) && access.usable!.has(stop.ref))) return refuse(['ENDPOINT_NOT_STEP_FREE']);
      }
      stepFree = { usableStopRefs: access.usable as ReadonlySet<TransitRef> };
    }
    if (feed.payload?.some(update => ['DUPLICATED', 'REPLACEMENT'].includes(update.scheduleRelationship ?? ''))) {
      return complete({ ...unavailable(coverageId, data, ['REALTIME_UNAVAILABLE']), sources: [...metadata(coverageId, data).sources, ...realtimeSource(data, feed, 'trip_updates', Date.parse(now) / 1000)], itineraries: [] });
    }
    // A stop the search cannot board or alight at (a Metrobus stop in an open search, or a stop
    // none of the named lines serve) is planned from its location: the journey walks from or to it.
    const allStops = data.indexes.flatMap(index => index.stops);
    // Remember what the rider asked for: an endpoint planned from its location keeps its name.
    const askedName = (endpoint: JourneyEndpoint | undefined) => {
      if (typeof endpoint !== 'string') return null;
      const stop = allStops.find(item => item.ref === endpoint), parent = stop?.parentStationRef ? allStops.find(item => item.ref === stop.parentStationRef) : undefined;
      return stop ? sanitizeTransitText(parent?.name ?? stop.name, 200) : null;
    };
    const asked = { origin: askedName(resolved.origin), destination: askedName(resolved.destination) };
    const servedByRoutes = (ref: string) => [ref, ...allStops.filter(stop => stop.parentStationRef === ref).map(stop => stop.ref)].some(stop => routeStops!.has(stop));
    for (const endpoint of ['origin', 'destination'] as const) {
      const value = resolved[endpoint], parsed = typeof value === 'string' ? parseTransitRef(value) : null;
      if (!parsed || planning.includes(parsed.feed) && (!routeStops || servedByRoutes(value as string))) continue;
      const stop = data.indexes.find(index => index.feedId === parsed.feed)?.stops.find(item => item.ref === value);
      if (stop?.latitude != null && stop.longitude != null) resolved[endpoint] = { latitude: stop.latitude, longitude: stop.longitude };
    }
    // One decode per shard: the planner fills this, and leg details read trips from it.
    const decoded = new DecodedShardCache(Number.MAX_SAFE_INTEGER);
    const planned = planJourney({ manifest: data.manifest, feedIds: planning, readShard: data.readObject, decoded, origin: resolved.origin!, destination: resolved.destination!, departAt: args.departAt ?? now, now,
      windowSeconds: args.windowSeconds, maxWalkMetres: args.maxWalkMetres, maxTransfers: args.maxTransfers, realtimeMaxAgeSeconds: data.coverage.thresholds.tripUpdates.realtimeSeconds,
      // Journeys come only from schedule data; observed-only rows cannot form legs.
      realtime: feed.payload !== null && feed.version && feed.receivedAtSeconds !== undefined ? { ...feed, payload: scheduledRealtimeRows(feed.payload), version: feed.version, receivedAtSeconds: feed.receivedAtSeconds } : undefined,
      ...(stepFree ? { stepFree } : {}),
      // Agency-split schedules (SF Bay) decode only the agencies this journey can use.
      ...(viaRoutes ? { routeRefs: new Set(viaRoutes), agencyRefs: [...new Set(viaRoutes.map(ref => data.indexes.flatMap(index => index.routes).find(route => route.ref === ref)!.agencyRef))] }
        : (() => { const agencyRefs = journeyAgencies(data, [resolved.origin!, resolved.destination!], Math.min(800, args.maxWalkMetres ?? 800)); return agencyRefs ? { agencyRefs } : {}; })()) }, handler.mcpReq.signal);
    let result: Awaited<typeof planned>;
    // A search too large for this isolate is a scope limit, not missing coverage.
    try { result = await planned; }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Planner working-set budget exceeded')) return hinted(['SCOPE_LIMIT_EXCEEDED']);
      throw error;
    }
    const legTrips = new Set(result.candidates.flatMap(candidate => candidate.legs.flatMap(leg => leg.kind === 'transit' ? [leg.tripRef as string] : [])));
    const sequences = new Map<string, number[]>();
    for (const shard of decoded.shards()) for (const trip of shard.trips) if (legTrips.has(trip.ref)) sequences.set(trip.ref, trip.stopTimes.map(call => call.sequence));
    const meta = metadata(coverageId, data, now);
    if (feed) meta.sources.push(...realtimeSource(data, feed, 'trip_updates', Date.parse(now) / 1000));
    meta.sources.push(...accessSources);
    const routes = data.indexes.flatMap(index => index.routes);
    const stopRows = new Map(data.indexes.flatMap(index => index.stops).map(stop => [stop.ref as string, stop]));
    const placeName = (endpoint: unknown) => {
      if (typeof endpoint !== 'string') return null;
      const stop = stopRows.get(endpoint), parent = stop?.parentStationRef ? stopRows.get(stop.parentStationRef) : undefined;
      return sanitizeTransitText(parent?.name ?? stop?.name ?? '', 200);
    };
    type OutLeg = { kind: string; from: unknown; to: unknown; departureTime: string; arrivalTime: string; distanceMetres?: number; verification?: string; routeRef?: string; headsign?: string;
      mode?: string; status?: 'realtime' | 'scheduled_only'; intermediateStopCount?: number; tripInstanceRef?: string };
    const riderSteps = (legs: OutLeg[]) => {
      const steps: z.infer<typeof stepSchema>[] = [];
      for (const leg of legs) {
        const last = steps.at(-1);
        if (leg.kind === 'walk' && last?.kind === 'walk') {
          last.toName = placeName(leg.to); last.arrivalTime = leg.arrivalTime; last.distanceMetres += leg.distanceMetres ?? 0;
          last.throughStation ||= leg.verification === 'pathway';
        } else if (leg.kind === 'walk') {
          steps.push({ kind: 'walk', fromName: placeName(leg.from), toName: placeName(leg.to), departureTime: leg.departureTime, arrivalTime: leg.arrivalTime,
            distanceMetres: leg.distanceMetres ?? 0, minutes: 0, throughStation: leg.verification === 'pathway' });
        } else {
          const route = routes.find(item => item.ref === leg.routeRef);
          steps.push({ kind: 'ride', routeName: route ? routeName(route) : '', headsign: sanitizeTransitText(leg.headsign ?? '', 200), mode: leg.mode ?? '', fromName: placeName(leg.from) ?? '', toName: placeName(leg.to) ?? '',
            departureTime: leg.departureTime, arrivalTime: leg.arrivalTime, status: leg.status ?? 'scheduled_only', intermediateStopCount: leg.intermediateStopCount ?? 0, tripInstanceRef: leg.tripInstanceRef ?? '' });
        }
      }
      for (const step of steps) if (step.kind === 'walk') { step.distanceMetres = Math.round(step.distanceMetres); step.minutes = Math.round((Date.parse(step.arrivalTime) - Date.parse(step.departureTime)) / 60000); }
      // A zero-length walk (boarding where you stand) says nothing to a rider.
      const kept = steps.filter(step => step.kind === 'ride' || step.distanceMetres > 0), first = kept[0], final = kept.at(-1);
      if (first?.kind === 'walk' && first.fromName === null) first.fromName = asked.origin;
      if (final?.kind === 'walk' && final.toName === null) final.toName = asked.destination;
      return kept;
    };
    return complete({ ...meta, status: result.status, reasons: [...new Set([...result.reasons, ...feed.reasons])], itineraries: result.candidates.map(candidate => ({ ...candidate, legs: candidate.legs.map((leg, index) => {
      if (leg.kind === 'walk') return { ...leg, validatorOutcome: 'valid' as const };
      const route = routes.find(route => route.ref === leg.routeRef)!;
      return { ...leg, mode: route.mode, agencyRef: route.agencyRef, intermediateStopCount: (sequences.get(leg.tripRef) ?? []).filter(sequence => sequence > leg.boardSequence && sequence < leg.alightSequence).length,
        transferRequired: candidate.legs.slice(0, index).some(prior => prior.kind === 'transit') && !leg.continuation, sources: meta.sources.filter(source => source.scheduleVersion === leg.scheduleVersion), validatorOutcome: 'valid' as const };
    }) })).map(itinerary => ({ ...itinerary, steps: riderSteps(itinerary.legs) })), ...(result.candidates.length ? {} : { routeHints: routeHints(data, resolved.origin!, resolved.destination!, walkMetres) }) });
  }), () => complete({ ...unavailable(args.coverage), itineraries: [] })));
}
