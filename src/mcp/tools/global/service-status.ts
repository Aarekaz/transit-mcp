import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { traced } from '../../../transit/trace';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getCoverage } from '../../../transit/core/coverage';
import type { VerificationReason } from '../../../transit/core/results';
import { safeAlertIdentifier, safeAlertSelector, type NormalizedAlert, type NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { validateItinerary } from '../../../transit/planner/validator';
import { DecodedShardCache, loadScheduleWindow } from '../../../transit/planner/schedule-index';
import { serviceDayOrigin } from '../../../transit/planner/service-day';
import { parseGtfsTime } from '../../../transit/gtfs/static/time';
import { parseTransitRef } from '../../../transit/core/refs';
import { matchTripInstance } from '../../../transit/gtfs/realtime/trip-match';
import type { ScheduleShard } from '../../../transit/gtfs/static/schema';
import { AlertScopeLimitError, expandAlertScopes, matchesAlertSelector, resolveAlertSelector, type AlertScope } from '../../../transit/gtfs/realtime/alert-match';
import { itinerarySchema } from './plan';
import { blockedStations, currentOutage, outageStations, stationOf, type EquipmentOutage } from '../../../transit/accessibility/equipment';
import { MAX_DISCOVERY_CANDIDATES, TransitToolError, stopMatches, asTransitRef, boundedText, checkState, complexStations, coverageSchema, effectiveCapabilities, guarded, instantSchema, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, scheduledRealtimeRows, unavailable, validRef, type TransitData } from './shared';

/** Per-alert detail bound: a city-wide status call stays readable for a model. */
export const ALERT_DETAIL_LIMIT = 20;
/** Equipment outages listed per call; `count` is the full number in scope. */
export const EQUIPMENT_DETAIL_LIMIT = 20;
const UPCOMING_HORIZON_SECONDS = 86400;

const equipmentSchema = z.strictObject({
  status: z.enum(['current', 'stale', 'unavailable', 'not_offered']).describe('Freshness of the agency equipment report; not_offered when this coverage publishes none.'),
  count: z.number().int().nonnegative(), blockingStepFreeCount: z.number().int().nonnegative(),
  outages: z.array(z.strictObject({ equipmentId: z.string(), kind: z.enum(['elevator', 'escalator']), stationRefs: z.array(z.string()).max(8), stationName: z.string(), location: z.string(),
    accessiblePath: z.boolean().describe('On the step-free (ADA) path.'), hasBackup: z.boolean().nullable().describe('Agency says another elevator covers the same path; null when it does not say.'),
    blocksStepFree: z.boolean().describe('Step-free plan_trip avoids these stations while this lasts.'), reason: z.string(), since: instantSchema.nullable(), estimatedReturn: instantSchema.nullable(),
    upcoming: z.boolean().describe('Announced, starting within 24 hours.'), alternativeRoute: z.string().nullable().describe('Agency-supplied way around the outage.') }))
    .describe(`At most ${EQUIPMENT_DETAIL_LIMIT}, blocking and accessible-path outages first.`),
});

/** Elevator and escalator outages at the scoped stations (all, for a coverage or agency). */
async function equipmentReport(context: MetroMcpContext, data: TransitData, stations: Set<string> | 'all', nowSeconds: number, signal: AbortSignal) {
  if (!effectiveCapabilities(context, data.coverage, false).accessibility) return { report: { status: 'not_offered' as const, count: 0, blockingStepFreeCount: 0, outages: [] }, sources: [] };
  const feed = await readFeed<EquipmentOutage>(context, data, 'equipment_outages', nowSeconds, signal);
  const sources = realtimeSource(data, feed, 'equipment_outages', nowSeconds);
  if (!feed.payload) return { report: { status: 'unavailable' as const, count: 0, blockingStepFreeCount: 0, outages: [] }, sources };
  const rows = data.indexes.flatMap(index => {
    const blocked = blockedStations(feed.payload!, index, nowSeconds);
    return feed.payload!.flatMap(outage => {
      const current = currentOutage(outage, nowSeconds);
      if (!current && !(outage.upcoming && outage.sinceSeconds !== null && outage.sinceSeconds <= nowSeconds + UPCOMING_HORIZON_SECONDS)) return [];
      const refs = outageStations(outage, index);
      if (stations !== 'all' && !refs.some(ref => stations.has(ref))) return [];
      const blocksStepFree = current && outage.kind === 'elevator' && outage.accessiblePath && refs.some(ref => blocked.has(ref));
      return [{ equipmentId: outage.id, kind: outage.kind, stationRefs: refs.slice(0, 8), stationName: outage.stationName, location: outage.location, accessiblePath: outage.accessiblePath,
        hasBackup: outage.redundant, blocksStepFree, reason: outage.reason, since: outage.sinceSeconds === null ? null : new Date(outage.sinceSeconds * 1000).toISOString(),
        estimatedReturn: outage.estimatedReturnSeconds === null ? null : new Date(outage.estimatedReturnSeconds * 1000).toISOString(), upcoming: !current, alternativeRoute: outage.alternativeRoute }];
    });
  }).sort((a, b) => Number(b.blocksStepFree) - Number(a.blocksStepFree) || Number(b.accessiblePath) - Number(a.accessiblePath) || Number(a.upcoming) - Number(b.upcoming) ||
    (a.since ?? '').localeCompare(b.since ?? '') || a.equipmentId.localeCompare(b.equipmentId));
  return { report: { status: feed.freshness === 'fresh' ? 'current' as const : 'stale' as const, count: rows.length, blockingStepFreeCount: rows.filter(row => row.blocksStepFree).length,
    outages: rows.slice(0, EQUIPMENT_DETAIL_LIMIT) }, sources };
}

export function registerServiceStatusTool(server: McpServer, context: MetroMcpContext): void {
  const absent = { coverage: z.never().optional(), ref: z.never().optional(), itinerary: z.never().optional(), stop: z.never().optional() };
  const selectorSchema = z.strictObject({ agencyId: z.string().optional(), routeId: z.string().optional(), routeType: z.number().int().optional(), stopId: z.string().optional(), directionId: z.number().int().optional(),
    trip: z.strictObject({ tripId: z.string().optional(), startDate: z.string().optional(), startTime: z.string().optional(), routeId: z.string().optional(), directionId: z.number().int().optional() }).optional() });
  server.registerTool('get_service_status', {
    title: 'Transit service status', description: 'Check disruptions, delays, closures, elevator and escalator outages, or revalidate a chosen itinerary without replacing it. Scope by coverage, a station name with its coverage (stop), or an agency, route, stop or dated trip reference; a station covers its complex. Aggregate scopes include canonical service in the next 24 hours. equipment lists elevator/escalator outages: accessiblePath marks the step-free route, blocksStepFree marks stations step-free plan_trip avoids, and alternativeRoute is the agency\'s way around. Use get_vehicle_status for an observed vehicle location.',
    annotations: readOnlyLive('Transit service status'),
    inputSchema: z.union([z.strictObject({ ...absent, coverage: coverageSchema }), z.strictObject({ ...absent, ref: boundedText }),
      z.strictObject({ ...absent, stop: boundedText.describe('Station name, e.g. "Fulton St"; a station covers its complex.'), coverage: coverageSchema }), z.strictObject({ ...absent, itinerary: z.record(z.string(), z.unknown())
      .describe('An itinerary exactly as plan_trip returned it; validated strictly against that contract.') })]),
    outputSchema: z.strictObject({ ...resultShape, alerts: z.array(z.strictObject({ id: z.string(), agencyText: z.strictObject({ title: z.string(), description: z.string(), label: z.literal('agency_supplied') }),
      routeIds: z.array(z.string()), stopIds: z.array(z.string()).describe(`At most ${ALERT_DETAIL_LIMIT}; stopCount is the full number.`),
      selectors: z.array(selectorSchema).describe(`At most ${ALERT_DETAIL_LIMIT}; selectorCount is the full number.`), selectorCount: z.number().int().nonnegative(), stopCount: z.number().int().nonnegative(), stale: z.boolean(),
      activePeriods: z.array(z.strictObject({ start: instantSchema.nullable(), end: instantSchema.nullable() })).max(32) })),
      journeyValid: z.boolean().nullable(), journeyReasons: z.array(z.string()),
      legChecks: z.array(z.strictObject({ index: z.number().int(), valid: z.boolean(), reasons: z.array(z.string()) })),
      transferChecks: z.array(z.strictObject({ fromLegIndex: z.number().int(), toLegIndex: z.number().int(), valid: z.literal(false), reasons: z.array(z.string()) })),
      equipment: equipmentSchema.optional().describe('Elevator and escalator outages in scope, where the coverage publishes them.') }),
  }, async (args, handler) => guarded(handler, () => traced('get_service_status', async () => {
    checkState(handler, 'get_service_status');
    // A station by name, resolved as get_departures does, then checked as that station.
    if ('stop' in args && args.stop) {
      const coverageId = getCoverage(args.coverage ?? '')?.id;
      if (!coverageId) throw new TransitToolError('ENTITY_NOT_FOUND');
      const named = await loadData(context, coverageId, handler.mcpReq.signal);
      if (!named) return complete({ ...unavailable(coverageId), alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] });
      const matches = stopMatches(named, args.stop);
      if (!matches.length) throw new TransitToolError('ENTITY_NOT_FOUND');
      if (matches.length > 1) throw new TransitToolError('ENTITY_AMBIGUOUS', matches.slice(0, MAX_DISCOVERY_CANDIDATES));
      args = { ref: matches[0]!.ref } as unknown as typeof args;
    }
    const parsed = args.ref ? validRef(args.ref, ['agency', 'route', 'stop', 'trip'], true) : undefined;
    // The advertised input stays small; the itinerary contract is enforced here.
    const checked = args.itinerary === undefined ? undefined : itinerarySchema.safeParse(args.itinerary);
    if (checked && !checked.success) throw new TransitToolError('INVALID_ITINERARY');
    const inputItinerary = checked?.data;
    const id = parsed?.coverage ?? inputItinerary?.coverageId ?? getCoverage(args.coverage ?? '')?.id ?? args.coverage!;
    const data = await loadData(context, id, handler.mcpReq.signal);
    if (!data) return complete({ ...unavailable(id), alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] });
    if (args.ref) knownEntity(data, args.ref);
    const now = new Date().toISOString(), nowSeconds = Date.parse(now) / 1000;
    // Alert selectors name provider IDs that are meaningful only inside their own feed.
    const feed = await readFeed<NormalizedAlert>(context, data, 'service_alerts', nowSeconds, handler.mcpReq.signal);
    const resultReasons = new Set<VerificationReason>();
    const meta = metadata(id, data, now);
    const sources = [...meta.sources, ...(feed ? realtimeSource(data, feed, 'alerts', nowSeconds) : [])];
    const canonicalShards: ScheduleShard[] = [];
    const scopeUnavailable = (reasons: VerificationReason[] = ['SCOPE_LIMIT_EXCEEDED']) => complete({ ...unavailable(id, data, reasons), sources, alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] });
    // A trip-pattern selector names one trip by route, direction and start: resolving it needs
    // only the timetable running at that start, not a day of every feed (Bus Time sends many).
    if (args.coverage) {
      const patterns = new Map<string, { feedId: string; date: string; start: string }>();
      for (const part of feed.parts) for (const alert of part.payload ?? []) for (const selector of alert.selectors ?? []) {
        const trip = selector.trip;
        if (trip && trip.tripId === undefined && trip.startDate && trip.startTime) for (const feedId of part.feedIds ?? [part.feedId]) patterns.set(`${feedId}/${trip.startDate}/${trip.startTime}`, { feedId, date: trip.startDate, start: trip.startTime });
      }
      const decoded = new DecodedShardCache(Number.MAX_SAFE_INTEGER), loaded = new Set<string>();
      // An expired timetable cannot interpret them: fail closed rather than drop alerts.
      const patternFeeds = [...new Set([...patterns.values()].map(pattern => pattern.feedId))];
      if (patternFeeds.length) {
        const current = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant: now, windowSeconds: 60, feedIds: patternFeeds, decoded });
        if (current.status === 'unavailable') return scopeUnavailable(current.reasons);
      }
      for (const { feedId, date, start } of patterns.values()) {
        const timezone = Object.entries(data.manifest.agencyTimezones).find(([ref]) => parseTransitRef(ref)?.feed === feedId)?.[1];
        if (!timezone) continue;
        let instant: string;
        try { instant = new Date(serviceDayOrigin(date, timezone) + parseGtfsTime(start).totalSeconds * 1000).toISOString(); } catch { continue; }
        const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant, windowSeconds: 60, feedIds: [feedId], decoded });
        for (const item of schedule.shards) if (!loaded.has(item.key)) { loaded.add(item.key); canonicalShards.push(item.shard); }
      }
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
      // A dated instance names its scheduled start: load only the timetable running then.
      const day = parsed.serviceDate, timezone = Object.entries(data.manifest.agencyTimezones).find(([ref]) => parseTransitRef(ref)?.feed === parsed.feed)?.[1];
      const instant = timezone && 'startTime' in parsed && typeof parsed.startTime === 'string' ? new Date(serviceDayOrigin(day, timezone) + parseGtfsTime(parsed.startTime).totalSeconds * 1000).toISOString()
        : `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T12:00:00Z`;
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant, windowSeconds: timezone ? 1 : 86400, feedIds: [parsed.feed] });
      canonicalShards.push(...schedule.shards.map(item => item.shard));
      if (!addTrip(args.ref!, schedule.shards.map(item => item.shard))) throw new TransitToolError('ENTITY_NOT_FOUND');
    }
    const legChecks: { index: number; valid: boolean; reasons: string[] }[] = [];
    const transferChecks: { fromLegIndex: number; toLegIndex: number; valid: false; reasons: string[] }[] = [];
    let journeyValid: boolean | null = null, journeyReasons: string[] = [];
    if (inputItinerary) {
      const itinerary = inputItinerary;
      // Only the feeds its legs ride: a coverage may hold far larger ones (Metrobus).
      const legFeeds = [...new Set(itinerary.legs.flatMap(leg => leg.kind === 'transit' ? [parseTransitRef(leg.tripInstanceRef)?.feed ?? ''] : []))];
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant: itinerary.departAt, windowSeconds: itinerary.windowSeconds, feedIds: legFeeds });
      canonicalShards.push(...schedule.shards.map(item => item.shard));
      for (const leg of itinerary.legs) if (leg.kind === 'transit') addTrip(leg.tripInstanceRef, schedule.shards.map(item => item.shard), leg.boardSequence, leg.alightSequence,
        { start: Date.parse(leg.departureTime) / 1000, end: Date.parse(leg.arrivalTime) / 1000 });
      const realtime = await readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', nowSeconds, handler.mcpReq.signal);
      realtime.reasons.forEach(reason => resultReasons.add(reason));
      if (realtime) sources.push(...realtimeSource(data, realtime, 'trip_updates', nowSeconds));
      const validation = await validateItinerary(itinerary as Parameters<typeof validateItinerary>[0], { manifest: data.manifest, shards: schedule.shards.map(item => item.shard), now,
        recheck: true, realtimeReasons: realtime.reasons,
        realtimeMaxAgeSeconds: data.coverage.thresholds.tripUpdates.realtimeSeconds,
        realtime: realtime?.version && realtime.receivedAtSeconds !== undefined ? { ...realtime, payload: scheduledRealtimeRows(realtime.payload), version: realtime.version, receivedAtSeconds: realtime.receivedAtSeconds } : undefined }, handler.mcpReq.signal);
      journeyValid = validation.valid; journeyReasons = validation.reasons;
      if (!journeyValid) resultReasons.add('VALIDATOR_REJECTED');
      itinerary.legs.forEach((_leg, index) => {
        const reasons = validation.legFailures.find(failure => failure.index === index)?.reasons ?? [];
        legChecks.push({ index, valid: reasons.length === 0, reasons });
      });
      transferChecks.push(...validation.transferFailures.map(failure => ({ ...failure, valid: false as const })));
    }
    // Alerts may name a parent station while timetables name its platforms (NYCT).
    const parents = new Map(data.indexes.flatMap(index => index.stops).flatMap(stop => {
      const parent = stop.parentStationRef ? parseTransitRef(stop.parentStationRef) : null;
      return parent ? [[`${parseTransitRef(stop.ref)!.feed}\u0000${stop.providerId}`, parent.id] as const] : [];
    }));
    for (const scope of scopes) for (const id of [...scope.stopIds]) {
      const parent = parents.get(`${scope.feedId}\u0000${id}`);
      if (parent) scope.stopIds.add(parent);
    }
    const partFeeds = (part: typeof feed.parts[number]) => part.feedIds ?? [part.feedId];
    const relevant = feed.parts.filter(part => args.coverage || partFeeds(part).some(id => feeds.has(id)));
    relevant.forEach(part => part.reasons.forEach(reason => resultReasons.add(reason)));
    // Older persisted snapshots lack selector groups; never reconstruct their
    // conjunctions from lossy arrays or advertise a false empty service state.
    const usableParts = relevant.filter(part => part.payload !== null && part.payload !== undefined && part.payload.every(alert => Array.isArray(alert.selectors)));
    const usable = usableParts.length > 0;
    const active = (alert: NormalizedAlert, start: number, end: number) => !alert.activePeriods?.length || alert.activePeriods.some(period => (period.start ?? -Infinity) < end && (period.end ?? Infinity) > start);
    let alerts: { id: string; agencyText: { title: string; description: string; label: 'agency_supplied' }; selectors: NormalizedAlert['selectors']; routeIds: string[]; stopIds: string[]; stale: boolean; activePeriods: { start: string | null; end: string | null }[] }[];
    try { alerts = usableParts.flatMap(part => part.payload!.flatMap(alert => {
      if (!safeAlertIdentifier(alert.id) || alert.selectors.some(selector => !safeAlertSelector(selector)) || (alert.activePeriods?.length ?? 0) > 32) return [];
      const inWindow = (scope: typeof scopes[number]) => active(alert, scope.window?.start ?? nowSeconds, scope.window?.end ?? nowSeconds + 86400);
      if (args.coverage ? !active(alert, nowSeconds, nowSeconds + 86400) : !scopes.some(inWindow)) return [];
      const selectors = alert.selectors.filter(selector => {
        // A source describing several timetables (Bus Time) resolves a selector in each.
        return partFeeds(part).some(feedId => {
          const resolved = resolveAlertSelector(selector, { manifest: data.manifest, version: data.version, shards: canonicalShards, feedId });
          return resolved && (args.coverage || scopes.some(scope => scope.feedId === feedId && inWindow(scope) && matchesAlertSelector(resolved, scope)));
        });
      });
      if (alert.selectors.length && !selectors.length) return [];
      // NYCT alerts name every affected platform; report exact counts and a bounded sample.
      const stopIds = [...new Set(selectors.flatMap(selector => selector.stopId === undefined ? [] : [selector.stopId]))];
      return [{ id: alert.id, agencyText: { title: sanitizeTransitText(alert.header), description: sanitizeTransitText(alert.description), label: 'agency_supplied' as const },
        selectors: selectors.slice(0, ALERT_DETAIL_LIMIT), selectorCount: selectors.length,
        routeIds: [...new Set(selectors.flatMap(selector => selector.routeId === undefined ? [] : [selector.routeId]))],
        stopIds: stopIds.slice(0, ALERT_DETAIL_LIMIT), stopCount: stopIds.length, stale: part.freshness !== 'fresh',
        activePeriods: (alert.activePeriods ?? []).map(period => ({ start: period.start === undefined ? null : new Date(period.start * 1000).toISOString(), end: period.end === undefined ? null : new Date(period.end * 1000).toISOString() })) }];
    })); } catch (error) { if (error instanceof AlertScopeLimitError) return scopeUnavailable(); throw error; }
    // Stations in scope: a station covers its complex; routes, trips and itineraries their stops' stations.
    const stopIndex = new Map(data.indexes.flatMap(index => index.stops).map(stop => [stop.ref as string, stop]));
    let stations: Set<string> | 'all' = 'all';
    if (parsed?.kind === 'stop') { const station = stationOf(args.ref!, stopIndex); stations = new Set([station, ...complexStations(data, station)]); }
    else if (parsed?.kind === 'route') stations = new Set(data.indexes.flatMap(index => Object.entries(index.stopRoutes).filter(([, routes]) => routes.includes(asTransitRef(args.ref!))).map(([ref]) => stationOf(ref, stopIndex))));
    else if (parsed?.kind === 'trip' || inputItinerary) {
      const ids = new Set(inputItinerary ? inputItinerary.legs.flatMap(leg => leg.kind === 'transit' ? [leg.from, leg.to] : []) : scopes.flatMap(scope => [...scope.stopIds].map(id => `${scope.feedId}\u0000${id}`)));
      stations = new Set([...stopIndex.values()].filter(stop => ids.has(stop.ref) || ids.has(`${parseTransitRef(stop.ref)!.feed}\u0000${stop.providerId}`)).map(stop => stationOf(stop.ref, stopIndex)));
    }
    const equipment = await equipmentReport(context, data, stations, nowSeconds, handler.mcpReq.signal);
    sources.push(...equipment.sources);
    return complete({ ...meta, sources, equipment: equipment.report,
      status: usable && journeyValid !== false ? 'realtime' as const : 'unavailable' as const, reasons: resultReasons.size ? [...resultReasons] : usable ? [] : ['REALTIME_UNAVAILABLE' as const], alerts, journeyValid, journeyReasons, legChecks, transferChecks });
  }), () => complete({ ...unavailable(args.coverage), alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] })));
}
