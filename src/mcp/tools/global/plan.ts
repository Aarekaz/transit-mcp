import type { McpServer } from '@modelcontextprotocol/server';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { z } from 'zod';
import { traced } from '../../../transit/trace';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getCoverage, networkPlanning, planningFeedIds, planningWithheld } from '../../../transit/core/coverage';
import { parseTransitRef } from '../../../transit/core/refs';
import { planNetworkJourney } from '../../../transit/planner/network-plan';
import { planJourney } from '../../../transit/planner/plan';
import type { JourneyEndpoint } from '../../../transit/planner/types';
import type { TransitRef } from '../../../transit/core/refs';
import type { SourceStatus, VerificationReason } from '../../../transit/core/results';
import type { NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { DecodedShardCache } from '../../../transit/planner/schedule-index';
import { MAX_DISCOVERY_CANDIDATES, closestStops, residentShards, TransitToolError, asTransitRef, boundedText, routeHints, routeHintsSchema, routeName, effectiveCapabilities, journeyAgencies, validRef, checkState, coordinatesSchema, coverageSchema, endpointSchema, guarded, inferCoverage, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, stopPlaces, refPlace, placeLabel, scheduledRealtimeRows, sourceSchema, stepFreeAccess, unavailable, type TransitData } from './shared';

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
  status: z.enum(['realtime', 'scheduled_only']), legs: z.array(z.union([transitLeg, walkLeg])), steps: z.array(stepSchema).optional(),
  reading: z.strictObject({ origin: z.string().nullable(), destination: z.string().nullable() }).optional()
    .describe('When a name means several places: the place this trip is from and to (null: as given).') });
type Planned = z.infer<typeof itinerarySchema>;
/** What a journey endpoint stands for: where to plan from, the rest of its place, and how a rider names it. */
type Reading = { endpoint: JourneyEndpoint; stops: TransitRef[]; label?: string };
/** Readings of an ambiguous journey planned, at most: each is a full search. */
const MAX_READINGS = 3;

export const planInput = z.strictObject({ origin: endpointSchema, destination: endpointSchema, coverage: coverageSchema.optional(), departAt: instantSchema.optional(),
  windowSeconds: z.number().int().min(1).max(604800).default(7200), maxWalkMetres: z.number().min(0).max(800).default(800), maxTransfers: z.number().int().min(0).max(4).default(3),
  accessibility: z.enum(['no_preference', 'step_free']).default('no_preference').describe('step_free: only platforms reachable without stairs, avoiding current elevator outages.'),
  routes: z.array(boundedText).min(1).max(4).optional().describe('Route refs (from find_transit) the journey may ride, e.g. the lines you would take: BART from SFO, then a Muni line. The server finds the actual trips, boarding stops, transfers and walks on only these routes and validates them. Works where full search is unavailable (SF Bay) and for buses.') });
export function registerPlanTool(server: McpServer, context: MetroMcpContext): void {
  server.registerTool('plan_trip', {
    title: 'Plan a transit journey', description: 'Plan an origin-to-destination journey. Returns up to three independently validated itineraries (the fastest, then other lines); departure defaults to now. Pass the rider\'s place names as given: a name for one place (Penn Station, SFO) plans from or to all its stations. A name meaning different places (Broadway) returns the best trip from each, each labelled in reading and explained in notice: use the one the conversation points to, or ask the rider. The search covers every line of the coverage, buses included. When no itinerary is possible (planning unavailable, a search too large, or nothing found) it returns routeHints: lines near each end and direct lines serving both. Call again with routes (the lines you would ride, from routeHints or your own knowledge) to plan along only those lines, which works wherever schedules exist. Present only returned itineraries as confirmed. The whole journey must finish within windowSeconds (default two hours): if none is found for a long trip, retry with a larger window. Each transit leg carries a tripInstanceRef; pass it to get_vehicle_status to see where that train is now. For a wheelchair user or anyone avoiding stairs, set accessibility: "step_free": journeys then board, alight and change only at platforms step-free from the street per the agency (partial stations by direction), avoiding stations cut off by a current elevator outage; in-station changes between such platforms are taken as step-free. It refuses with ACCESSIBILITY_UNAVAILABLE when no current elevator report exists and ENDPOINT_NOT_STEP_FREE when an endpoint has no step-free platform now (get_service_status lists the outages). Never present a journey pieced together from get_departures as confirmed; check it here with routes.',
    annotations: readOnlyLive('Plan a transit journey'),
    inputSchema: planInput,
    outputSchema: z.strictObject({ ...resultShape, itineraries: z.array(itinerarySchema).max(3), routeHints: routeHintsSchema.optional(),
      notice: z.string().optional().describe('Set when a name means several places: which, and how the trips are labelled.') }),
  }, async (args, handler) => guarded(handler, () => traced('plan_trip', async () => {
    checkState(handler);
    const originCoverage = inferCoverage(args.origin), destinationCoverage = inferCoverage(args.destination);
    const coverageId = originCoverage ?? destinationCoverage ?? getCoverage(args.coverage ?? '')?.id ?? args.coverage;
    const noData = () => complete({ ...unavailable(coverageId), itineraries: [] });
    if (!coverageId || originCoverage && destinationCoverage && originCoverage !== destinationCoverage) return noData();
    const data = await loadData(context, coverageId, handler.mcpReq.signal);
    if (!data) return noData();
    const planningData: TransitData = data, planningCoverage: string = coverageId;
    // Proposed routes keep the search to a few lines, so it runs even where an open
    // search is withheld (SF Bay) and on feeds too large to search whole (buses).
    const viaRoutes = args.routes?.map(ref => {
      const parsed = validRef(ref, ['route']);
      if (parsed.coverage !== coverageId) throw new TransitToolError('INVALID_TRANSIT_REF');
      knownEntity(data, ref);
      return asTransitRef(ref);
    });
    // What an endpoint stands for: a point, a stop with its complex, or each place a name means.
    const readings = (endpoint: 'origin' | 'destination'): Reading[] | null => {
      const value = args[endpoint];
      if ('latitude' in value) return [{ endpoint: value, stops: [] }];
      if ('ref' in value) { knownEntity(data, value.ref); return [{ endpoint: asTransitRef(value.ref), stops: refPlace(data, value.ref).slice(1) }]; }
      const places = stopPlaces(data, value.query);
      if (!places.length) throw new TransitToolError('ENTITY_NOT_FOUND', closestStops(data, value.query));
      if (places.length > MAX_DISCOVERY_CANDIDATES) return null;
      return places.map(place => ({ endpoint: asTransitRef(place.candidate.ref), stops: place.members.filter(ref => ref !== place.candidate.ref), label: placeLabel(place.candidate) }));
    };
    const origins = readings('origin'), destinations = readings('destination');
    if (!origins || !destinations) return complete({ ...unavailable(coverageId, data, ['SCOPE_LIMIT_EXCEEDED']), itineraries: [] });
    // A name meaning different places is planned from each (the likeliest few), every trip
    // labelled, so the model picks by the conversation or asks the rider. One at a time:
    // each search holds its own working set.
    const pairs = origins.flatMap((origin, i) => destinations.map((destination, j) => ({ origin, destination, rank: i + j }))).sort((a, b) => a.rank - b.rank).slice(0, MAX_READINGS);
    if (pairs.length === 1) return complete(await planPair(pairs[0]!.origin, pairs[0]!.destination));
    const planned: Awaited<ReturnType<typeof planPair>>[] = [];
    for (const { origin, destination } of pairs) planned.push(await planPair(origin, destination));
    const found = planned.filter(result => result.itineraries.length);
    const named = (list: Reading[], endpoint: 'origin' | 'destination') => list.length > 1 ? `"${sanitizeTransitText((args[endpoint] as { query: string }).query, 80)}" is ${list.length} different places (${list.slice(0, 5).map(reading => reading.label).join('; ')}${list.length > 5 ? '; …' : ''})` : null;
    const notice = `${[named(origins, 'origin'), named(destinations, 'destination')].filter(Boolean).join(' and ')}. ${found.length ? 'The best trip for each reading follows, labelled in reading; use the one the conversation points to, or ask the rider which they mean.' : 'No reading has a trip: ask the rider which they mean.'}`;
    const sources = [...new Map(planned.flatMap(result => result.sources).map(source => [JSON.stringify(source), source])).values()];
    return complete({ ...(found[0] ?? planned[0]!), sources, status: found.some(result => result.status === 'realtime') ? 'realtime' as const : found.length ? 'scheduled_only' as const : 'unavailable' as const,
      reasons: [...new Set(planned.flatMap(result => result.reasons))], itineraries: found.map(result => result.itineraries[0]!), notice });

    async function planPair(origin: Reading, destination: Reading) {
    const data = planningData, coverageId = planningCoverage;
    const resolved = { origin: origin.endpoint, destination: destination.endpoint };
    const label = (reading: Reading) => reading.label ?? (typeof reading.endpoint === 'string' ? null : 'your point');
    // Labelled only when a name has several readings: the trip says which it is.
    const reading = pairs.length > 1 ? { origin: label(origin), destination: label(destination) } : undefined;
    // Without an itinerary, say which lines could carry the journey so the model can propose them.
    const walkMetres = Math.min(800, args.maxWalkMetres ?? 800);
    const hinted = (reasons: VerificationReason[]) => ({ ...unavailable(coverageId, data, reasons), itineraries: [] as Planned[], routeHints: routeHints(data, resolved.origin!, resolved.destination!, walkMetres) });
    if (!viaRoutes && !effectiveCapabilities(context, data.coverage, false).planning) return hinted(['PLANNING_UNAVAILABLE']);
    // The network planner searches every feed, buses included; the whole-feed router, only
    // what fits an isolate, and not at all where it is withheld (SF Bay).
    const network = !viaRoutes && networkPlanning(coverageId, context.env), wholeFeed = !planningWithheld(coverageId, context.env);
    // Only the published feeds a journey can ride: a bus feed's state says nothing about a rail plan.
    const planning = (viaRoutes ? [...new Set(viaRoutes.map(ref => parseTransitRef(ref)!.feed))] : planningFeedIds(data.coverage)).filter(feedId => data.version.sourceVersions[feedId] !== undefined);
    // Named lines need only their own stops' predictions, not a whole region's feed. A hub
    // filters at most 200 stops; beyond that read everything rather than drop rows.
    const routeStops = viaRoutes && new Set(data.indexes.flatMap(index => Object.entries(index.stopRoutes).filter(([, refs]) => refs.some(ref => viaRoutes.includes(ref))).map(([ref]) => ref)));
    const routeStopIds = routeStops && [...new Set(data.indexes.flatMap(index => index.stops).filter(stop => routeStops.has(stop.ref)).map(stop => stop.providerId))];
    // Read lazily: the network planner reads only its proposals' stops, and a whole region's
    // predictions (all of 511 SF Bay) cost seconds to move and parse.
    const now = new Date().toISOString();
    let wholeRead: ReturnType<typeof readFeed<NormalizedStopUpdate>> | undefined;
    const readPlanning = () => wholeRead ??= readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', Date.parse(now) / 1000, handler.mcpReq.signal,
      routeStopIds && routeStopIds.length <= 200 ? routeStopIds : [], planning);
    type PlanningRead = Awaited<ReturnType<typeof readPlanning>>;
    const duplicated = (read: PlanningRead) => read.payload?.some(update => ['DUPLICATED', 'REPLACEMENT'].includes(update.scheduleRelationship ?? ''));
    // Step-free: board, alight and change only where access is step-free now. Without a
    // current equipment report, or with an endpoint cut off, refuse rather than guess.
    let stepFree: { usableStopRefs: ReadonlySet<TransitRef> } | undefined, accessSources: SourceStatus[] = [];
    if (args.accessibility === 'step_free') {
      const access = await stepFreeAccess(context, data, Date.parse(now) / 1000, handler.mcpReq.signal);
      accessSources = access.sources;
      const refuse = (reasons: VerificationReason[]) => ({ ...unavailable(coverageId, data, reasons), sources: [...metadata(coverageId, data).sources, ...accessSources], itineraries: [] as Planned[] });
      if (!access.usable) return refuse(access.reasons);
      const stops = data.indexes.flatMap(index => index.stops);
      for (const endpoint of [resolved.origin!, resolved.destination!]) {
        if (typeof endpoint === 'string' && !stops.some(stop => (stop.ref === endpoint || stop.parentStationRef === endpoint) && access.usable!.has(stop.ref))) return refuse(['ENDPOINT_NOT_STEP_FREE']);
      }
      stepFree = { usableStopRefs: access.usable as ReadonlySet<TransitRef> };
    }
    const refuseDuplicated = (read: PlanningRead) => ({ ...unavailable(coverageId, data, ['REALTIME_UNAVAILABLE']), sources: [...metadata(coverageId, data).sources, ...realtimeSource(data, read, 'trip_updates', Date.parse(now) / 1000)], itineraries: [] as Planned[] });
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
    // The network planner rides every feed, so it plans between the stops as asked.
    const requested = { ...resolved };
    const servedByRoutes = (ref: string) => [ref, ...allStops.filter(stop => stop.parentStationRef === ref).map(stop => stop.ref)].some(stop => routeStops!.has(stop));
    for (const endpoint of ['origin', 'destination'] as const) {
      const value = resolved[endpoint], parsed = typeof value === 'string' ? parseTransitRef(value) : null;
      if (!parsed || planning.includes(parsed.feed) && (!routeStops || servedByRoutes(value as string))) continue;
      const stop = data.indexes.find(index => index.feedId === parsed.feed)?.stops.find(item => item.ref === value);
      if (stop?.latitude != null && stop.longitude != null) resolved[endpoint] = { latitude: stop.latitude, longitude: stop.longitude };
    }
    // One decode per shard: the planner fills this, and leg details read trips from it.
    const decoded = new DecodedShardCache(Number.MAX_SAFE_INTEGER);
    // Journeys come only from schedule data; observed-only rows cannot form legs.
    const plannerRealtime = (read: PlanningRead) => read.payload !== null && read.version && read.receivedAtSeconds !== undefined
      ? { ...read, payload: scheduledRealtimeRows(read.payload), version: read.version, receivedAtSeconds: read.receivedAtSeconds } : undefined;
    const realtimeReads: PlanningRead[] = [];
    let result: Awaited<ReturnType<typeof planJourney>> | null = null;
    if (network) {
      try {
        result = await planNetworkJourney({ manifest: data.manifest, indexes: data.indexes, readShard: data.readObject, decoded, resident: residentShards, origin: requested.origin!, destination: requested.destination!,
          originStops: origin.stops, destinationStops: destination.stops,
          departAt: args.departAt ?? now, now, windowSeconds: args.windowSeconds, maxWalkMetres: args.maxWalkMetres, maxTransfers: args.maxTransfers,
          realtimeMaxAgeSeconds: data.coverage.thresholds.tripUpdates.realtimeSeconds, ...(stepFree ? { stepFree } : {}),
          networkFeedIds: data.manifest.sources.map(source => source.feedId).filter(feedId => data.version.sourceVersions[feedId] !== undefined),
          readCompact: async key => { const object = await context.env.TRANSIT_ARTIFACTS!.get(key); if (!object) return null; if (object.size > 32 * 1024 * 1024) throw new Error('Compact band too large'); return new Uint8Array(await object.arrayBuffer()); },
          // Each proposal reads its own lines' stops; past the hub's 200-stop filter, the whole read.
          realtimeFor: async (routeRefs, feedIds) => {
            const stops = new Set(data.indexes.flatMap(index => Object.entries(index.stopRoutes).filter(([, refs]) => refs.some(ref => routeRefs.has(ref))).map(([ref]) => ref)));
            const ids = [...new Set(allStops.filter(stop => stops.has(stop.ref)).map(stop => stop.providerId))];
            const read = ids.length > 200 && feedIds.every(feedId => planning.includes(feedId)) ? await readPlanning()
              : await readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', Date.parse(now) / 1000, handler.mcpReq.signal, ids.length <= 200 ? ids : [], feedIds);
            if (duplicated(read)) return null;
            if (!realtimeReads.includes(read)) realtimeReads.push(read);
            return plannerRealtime(read);
          } }, handler.mcpReq.signal);
      } catch (error) {
        if (handler.mcpReq.signal.aborted || error instanceof Error && error.name === 'AbortError') throw error;
        // Never worse than before: an unexpected failure plans as if the network planner were off.
        console.warn(JSON.stringify({ event: 'network_plan_failed', coverage: coverageId, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
      }
      if (!result && !wholeFeed) return hinted(['PLANNING_UNAVAILABLE']);
    }
    if (!result) {
    const feed = await readPlanning();
    if (duplicated(feed)) return refuseDuplicated(feed);
    realtimeReads.push(feed);
    const planned = planJourney({ manifest: data.manifest, feedIds: planning, readShard: data.readObject, decoded, resident: residentShards, origin: resolved.origin!, destination: resolved.destination!, departAt: args.departAt ?? now, now,
      windowSeconds: args.windowSeconds, maxWalkMetres: args.maxWalkMetres, maxTransfers: args.maxTransfers, realtimeMaxAgeSeconds: data.coverage.thresholds.tripUpdates.realtimeSeconds,
      // Journeys come only from schedule data; observed-only rows cannot form legs.
      realtime: plannerRealtime(feed),
      ...(stepFree ? { stepFree } : {}),
      // Agency-split schedules (SF Bay) decode only the agencies this journey can use.
      ...(viaRoutes ? { routeRefs: new Set(viaRoutes), agencyRefs: [...new Set(viaRoutes.map(ref => data.indexes.flatMap(index => index.routes).find(route => route.ref === ref)!.agencyRef))] }
        : (() => { const agencyRefs = journeyAgencies(data, [resolved.origin!, resolved.destination!], Math.min(800, args.maxWalkMetres ?? 800)); return agencyRefs ? { agencyRefs } : {}; })()) }, handler.mcpReq.signal);
    // A search too large for this isolate is a scope limit, not missing coverage.
    try { result = await planned; }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Planner working-set budget exceeded')) return hinted(['SCOPE_LIMIT_EXCEEDED']);
      throw error;
    }
    }
    const legTrips = new Set(result.candidates.flatMap(candidate => candidate.legs.flatMap(leg => leg.kind === 'transit' ? [leg.tripRef as string] : [])));
    const sequences = new Map<string, number[]>();
    for (const shard of decoded.shards()) for (const trip of shard.trips) if (legTrips.has(trip.ref)) sequences.set(trip.ref, trip.stopTimes.map(call => call.sequence));
    const meta = metadata(coverageId, data, now);
    for (const read of realtimeReads) meta.sources.push(...realtimeSource(data, read, 'trip_updates', Date.parse(now) / 1000));
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
    return { ...meta, status: result.status, reasons: [...new Set([...result.reasons, ...realtimeReads.flatMap(read => read.reasons)])], itineraries: result.candidates.map(candidate => ({ ...candidate, legs: candidate.legs.map((leg, index) => {
      if (leg.kind === 'walk') return { ...leg, validatorOutcome: 'valid' as const };
      const route = routes.find(route => route.ref === leg.routeRef)!;
      return { ...leg, mode: route.mode, agencyRef: route.agencyRef, intermediateStopCount: (sequences.get(leg.tripRef) ?? []).filter(sequence => sequence > leg.boardSequence && sequence < leg.alightSequence).length,
        transferRequired: candidate.legs.slice(0, index).some(prior => prior.kind === 'transit') && !leg.continuation, sources: meta.sources.filter(source => source.scheduleVersion === leg.scheduleVersion), validatorOutcome: 'valid' as const };
    }) })).map(itinerary => ({ ...itinerary, steps: riderSteps(itinerary.legs), ...(reading ? { reading } : {}) })), ...(result.candidates.length ? {} : { routeHints: routeHints(data, resolved.origin!, resolved.destination!, walkMetres) }) };
    }
  }), () => complete({ ...unavailable(args.coverage), itineraries: [] })));
}
