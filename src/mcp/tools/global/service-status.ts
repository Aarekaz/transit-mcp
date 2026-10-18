import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getCoverage } from '../../../transit/core/coverage';
import type { VerificationReason } from '../../../transit/core/results';
import { safeAlertIdentifier, safeAlertSelector, type NormalizedAlert, type NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { validateItinerary } from '../../../transit/planner/validator';
import { loadScheduleWindow } from '../../../transit/planner/schedule-index';
import { parseTransitRef } from '../../../transit/core/refs';
import { matchTripInstance } from '../../../transit/gtfs/realtime/trip-match';
import type { ScheduleShard } from '../../../transit/gtfs/static/schema';
import { AlertScopeLimitError, expandAlertScopes, matchesAlertSelector, resolveAlertSelector, type AlertScope } from '../../../transit/gtfs/realtime/alert-match';
import { itinerarySchema } from './plan';
import { TransitToolError, asTransitRef, boundedText, checkState, coverageSchema, guarded, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, unavailable, validRef } from './shared';

export function registerServiceStatusTool(server: McpServer, context: MetroMcpContext): void {
  const absent = { coverage: z.never().optional(), ref: z.never().optional(), itinerary: z.never().optional() };
  const selectorSchema = z.strictObject({ agencyId: z.string().optional(), routeId: z.string().optional(), routeType: z.number().int().optional(), stopId: z.string().optional(), directionId: z.number().int().optional(),
    trip: z.strictObject({ tripId: z.string().optional(), startDate: z.string().optional(), startTime: z.string().optional(), routeId: z.string().optional(), directionId: z.number().int().optional() }).optional() });
  server.registerTool('get_service_status', {
    title: 'Transit service status', description: 'Check disruptions, delays, closures, accessibility alerts or revalidate a chosen itinerary without replacing it. Scope by coverage or an agency, route, stop or dated trip reference. Aggregate scopes include canonical service in the next 24 hours. Use get_vehicle_status for an observed vehicle location.',
    annotations: readOnlyLive('Transit service status'),
    inputSchema: z.union([z.strictObject({ ...absent, coverage: coverageSchema }), z.strictObject({ ...absent, ref: boundedText }), z.strictObject({ ...absent, itinerary: itinerarySchema })]),
    outputSchema: z.strictObject({ ...resultShape, alerts: z.array(z.strictObject({ id: z.string(), agencyText: z.strictObject({ title: z.string(), description: z.string(), label: z.literal('agency_supplied') }),
      routeIds: z.array(z.string()), stopIds: z.array(z.string()), selectors: z.array(selectorSchema), stale: z.boolean(),
      activePeriods: z.array(z.strictObject({ start: instantSchema.nullable(), end: instantSchema.nullable() })).max(32) })),
      journeyValid: z.boolean().nullable(), journeyReasons: z.array(z.string()),
      legChecks: z.array(z.strictObject({ index: z.number().int(), valid: z.boolean(), reasons: z.array(z.string()) })),
      transferChecks: z.array(z.strictObject({ fromLegIndex: z.number().int(), toLegIndex: z.number().int(), valid: z.literal(false), reasons: z.array(z.string()) })) }),
  }, async (args, handler) => guarded(handler, async () => {
    checkState(handler, 'get_service_status');
    const parsed = args.ref ? validRef(args.ref, ['agency', 'route', 'stop', 'trip'], true) : undefined;
    const id = parsed?.coverage ?? args.itinerary?.coverageId ?? getCoverage(args.coverage ?? '')?.id ?? args.coverage!;
    const data = await loadData(context, id, handler.mcpReq.signal);
    if (!data) return complete({ ...unavailable(id), alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] });
    if (args.ref) knownEntity(data, args.ref);
    const now = new Date().toISOString(), nowSeconds = Date.parse(now) / 1000;
    const feed = await readFeed<NormalizedAlert>(context, data, 'service_alerts', nowSeconds, handler.mcpReq.signal);
    const resultReasons = new Set(feed.reasons);
    const meta = metadata(id, data, now);
    const sources = [...meta.sources, ...(feed ? realtimeSource(data, feed, 'alerts', nowSeconds) : [])];
    const canonicalShards: ScheduleShard[] = [];
    const scopeUnavailable = (reasons: VerificationReason[] = ['SCOPE_LIMIT_EXCEEDED']) => complete({ ...unavailable(id, data, reasons), sources, alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] });
    if (args.coverage && feed?.payload?.some(alert => alert.selectors?.some(selector => selector.trip && selector.trip.tripId === undefined))) {
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant: now, windowSeconds: 86400, feedIds: [feed.feedId] });
      if (schedule.status === 'unavailable') return scopeUnavailable(schedule.reasons);
      canonicalShards.push(...schedule.shards.map(item => item.shard));
    }
    // Alert provider IDs are meaningful only inside the authoritative snapshot feed.
    const scopes: (AlertScope & { window?: { start: number; end: number } })[] = [], feeds = new Set<string>();
    const addTrip = (ref: string, shards: ScheduleShard[], board?: number, alight?: number, window?: { start: number; end: number }) => {
      const instance = parseTransitRef(ref);
      if (!instance || instance.kind !== 'trip' || !('serviceDate' in instance)) return false;
      const match = matchTripInstance({ entityId: 'scope', tripId: instance.id, startDate: instance.serviceDate, startTime: instance.startTime,
        scheduleRelationship: 'SCHEDULED', rawScheduleRelationship: 0, stops: [] }, { manifest: data.manifest, version: data.version, shards, feedId: instance.feed });
      if (!match || match.tripInstanceRef !== ref) return false;
      const route = match.shard.routes.find(route => route.ref === match.trip.routeRef)!;
      feeds.add(instance.feed);
      const calls = match.trip.stopTimes.filter(call => (board === undefined || call.sequence >= board) && (alight === undefined || call.sequence <= alight));
      scopes.push({ feedId: instance.feed, window: window ?? { start: match.originSeconds + (calls[0]?.departureSeconds ?? match.startSeconds) + match.shiftSeconds,
        end: match.originSeconds + (calls.at(-1)?.arrivalSeconds ?? match.startSeconds) + match.shiftSeconds }, agencyId: parseTransitRef(route.agencyRef)!.id, routeId: route.providerId, routeType: route.routeType, directionId: match.trip.directionId,
        tripId: instance.id, serviceDate: instance.serviceDate, startTime: instance.startTime, frequency: match.shard.frequencies.some(row => row.tripRef === match.trip.ref),
        stopIds: new Set(match.trip.stopTimes.filter(call => (board === undefined || call.sequence >= board) && (alight === undefined || call.sequence <= alight)).map(call => parseTransitRef(call.stopRef)!.id)) });
      return true;
    };
    if (parsed && parsed.kind !== 'trip') {
      feeds.add(parsed.feed);
      scopes.push({ feedId: parsed.feed, agencyId: parsed.kind === 'agency' ? parsed.id : undefined, stopIds: new Set(parsed.kind === 'stop' ? [parsed.id] : []) });
      const index = data.indexes.find(index => index.feedId === parsed.feed);
      const routes = index?.routes.filter(route => parsed.kind === 'route' ? route.ref === args.ref : parsed.kind === 'agency' ? route.agencyRef === args.ref : index.stopRoutes[asTransitRef(args.ref!)]?.includes(route.ref)) ?? [];
      for (const route of routes) scopes.push({ feedId: parsed.feed, agencyId: parseTransitRef(route.agencyRef)!.id, routeId: route.providerId, routeType: route.routeType,
        stopIds: new Set(parsed.kind === 'stop' ? [parsed.id] : Object.entries(index?.stopRoutes ?? {}).filter(([, refs]) => refs.includes(route.ref)).map(([ref]) => parseTransitRef(ref)!.id)) });
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant: now, windowSeconds: 86400, feedIds: [parsed.feed] });
      if (schedule.status === 'unavailable') return scopeUnavailable(schedule.reasons);
      canonicalShards.push(...schedule.shards.map(item => item.shard));
      try { scopes.push(...expandAlertScopes(schedule.shards, parsed, Date.parse(now), Date.parse(now) + 86400_000)); }
      catch (error) { if (error instanceof AlertScopeLimitError) return scopeUnavailable(); throw error; }
    }
    if (parsed?.kind === 'trip' && 'serviceDate' in parsed && typeof parsed.serviceDate === 'string') {
      const day = parsed.serviceDate, instant = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T12:00:00Z`;
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant, windowSeconds: 86400, feedIds: [parsed.feed] });
      canonicalShards.push(...schedule.shards.map(item => item.shard));
      if (!addTrip(args.ref!, schedule.shards.map(item => item.shard))) throw new TransitToolError('ENTITY_NOT_FOUND');
    }
    const legChecks: { index: number; valid: boolean; reasons: string[] }[] = [];
    const transferChecks: { fromLegIndex: number; toLegIndex: number; valid: false; reasons: string[] }[] = [];
    let journeyValid: boolean | null = null, journeyReasons: string[] = [];
    if (args.itinerary) {
      const itinerary = args.itinerary;
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant: itinerary.departAt, windowSeconds: itinerary.windowSeconds });
      canonicalShards.push(...schedule.shards.map(item => item.shard));
      for (const leg of itinerary.legs) if (leg.kind === 'transit') addTrip(leg.tripInstanceRef, schedule.shards.map(item => item.shard), leg.boardSequence, leg.alightSequence,
        { start: Date.parse(leg.departureTime) / 1000, end: Date.parse(leg.arrivalTime) / 1000 });
      const realtime = await readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', nowSeconds, handler.mcpReq.signal);
      realtime.reasons.forEach(reason => resultReasons.add(reason));
      if (realtime) sources.push(...realtimeSource(data, realtime, 'trip_updates', nowSeconds));
      const validation = await validateItinerary(itinerary as Parameters<typeof validateItinerary>[0], { manifest: data.manifest, shards: schedule.shards.map(item => item.shard), now,
        recheck: true, realtimeReasons: realtime.reasons,
        realtimeMaxAgeSeconds: data.coverage.thresholds.tripUpdates.realtimeSeconds,
        realtime: realtime?.version && realtime.receivedAtSeconds !== undefined ? { ...realtime, version: realtime.version, receivedAtSeconds: realtime.receivedAtSeconds } : undefined }, handler.mcpReq.signal);
      journeyValid = validation.valid; journeyReasons = validation.reasons;
      if (!journeyValid) resultReasons.add('VALIDATOR_REJECTED');
      itinerary.legs.forEach((_leg, index) => {
        const reasons = validation.legFailures.find(failure => failure.index === index)?.reasons ?? [];
        legChecks.push({ index, valid: reasons.length === 0, reasons });
      });
      transferChecks.push(...validation.transferFailures.map(failure => ({ ...failure, valid: false as const })));
    }
    const inFeed = !!args.coverage || !!feed && feeds.has(feed.feedId);
    // Older persisted snapshots lack selector groups; never reconstruct their
    // conjunctions from lossy arrays or advertise a false empty service state.
    const usable = inFeed && feed?.payload !== null && feed?.payload !== undefined && feed.payload.every(alert => Array.isArray(alert.selectors));
    const active = (alert: NormalizedAlert, start: number, end: number) => !alert.activePeriods?.length || alert.activePeriods.some(period => (period.start ?? -Infinity) < end && (period.end ?? Infinity) > start);
    let alerts: { id: string; agencyText: { title: string; description: string; label: 'agency_supplied' }; selectors: NormalizedAlert['selectors']; routeIds: string[]; stopIds: string[]; stale: boolean; activePeriods: { start: string | null; end: string | null }[] }[];
    try { alerts = (usable ? feed.payload! : []).flatMap(alert => {
      if (!safeAlertIdentifier(alert.id) || alert.selectors.some(selector => !safeAlertSelector(selector)) || (alert.activePeriods?.length ?? 0) > 32) return [];
      const inWindow = (scope: typeof scopes[number]) => active(alert, scope.window?.start ?? nowSeconds, scope.window?.end ?? nowSeconds + 86400);
      if (args.coverage ? !active(alert, nowSeconds, nowSeconds + 86400) : !scopes.some(inWindow)) return [];
      const selectors = alert.selectors.filter(selector => {
        const resolved = resolveAlertSelector(selector, { manifest: data.manifest, version: data.version, shards: canonicalShards, feedId: feed!.feedId });
        return resolved && (args.coverage || scopes.some(scope => scope.feedId === feed!.feedId && inWindow(scope) && matchesAlertSelector(resolved, scope)));
      });
      if (alert.selectors.length && !selectors.length) return [];
      return [{ id: alert.id, agencyText: { title: sanitizeTransitText(alert.header), description: sanitizeTransitText(alert.description), label: 'agency_supplied' as const }, selectors,
        routeIds: [...new Set(selectors.flatMap(selector => selector.routeId === undefined ? [] : [selector.routeId]))],
        stopIds: [...new Set(selectors.flatMap(selector => selector.stopId === undefined ? [] : [selector.stopId]))], stale: feed?.freshness !== 'fresh',
        activePeriods: (alert.activePeriods ?? []).map(period => ({ start: period.start === undefined ? null : new Date(period.start * 1000).toISOString(), end: period.end === undefined ? null : new Date(period.end * 1000).toISOString() })) }];
    }); } catch (error) { if (error instanceof AlertScopeLimitError) return scopeUnavailable(); throw error; }
    return complete({ ...meta, sources,
      status: usable && journeyValid !== false ? 'realtime' as const : 'unavailable' as const, reasons: resultReasons.size ? [...resultReasons] : usable ? [] : ['REALTIME_UNAVAILABLE' as const], alerts, journeyValid, journeyReasons, legChecks, transferChecks });
  }, () => complete({ ...unavailable(args.coverage), alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] })));
}
