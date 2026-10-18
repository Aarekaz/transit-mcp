import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getCoverage } from '../../../transit/core/coverage';
import type { NormalizedAlert, NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { validateItinerary } from '../../../transit/planner/validator';
import { loadScheduleWindow } from '../../../transit/planner/schedule-index';
import { parseTransitRef } from '../../../transit/core/refs';
import { matchTripInstance } from '../../../transit/gtfs/realtime/trip-match';
import type { ScheduleShard } from '../../../transit/gtfs/static/schema';
import { itinerarySchema } from './plan';
import { TransitToolError, asTransitRef, boundedText, checkState, coverageSchema, guarded, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, unavailable, validRef } from './shared';

export function registerServiceStatusTool(server: McpServer, context: MetroMcpContext): void {
  const absent = { coverage: z.never().optional(), ref: z.never().optional(), itinerary: z.never().optional() };
  server.registerTool('get_service_status', {
    title: 'Transit service status', description: 'Check disruptions, delays, closures, accessibility alerts or revalidate a chosen itinerary without replacing it. Scope by coverage or an agency, route, stop or dated trip reference. Use get_vehicle_status for an observed vehicle location.',
    annotations: readOnlyLive('Transit service status'),
    inputSchema: z.union([z.strictObject({ ...absent, coverage: coverageSchema }), z.strictObject({ ...absent, ref: boundedText }), z.strictObject({ ...absent, itinerary: itinerarySchema })]),
    outputSchema: z.strictObject({ ...resultShape, alerts: z.array(z.strictObject({ id: z.string(), agencyText: z.strictObject({ title: z.string(), description: z.string(), label: z.literal('agency_supplied') }),
      routeIds: z.array(z.string()), stopIds: z.array(z.string()), stale: z.boolean() })),
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
    const meta = metadata(id, data, now);
    const sources = [...meta.sources, ...(feed ? realtimeSource(data, feed, 'alerts', nowSeconds) : [])];
    // Alert provider IDs are meaningful only inside the authoritative snapshot feed.
    const routeIds = new Set<string>(), stopIds = new Set<string>(), tripIds = new Set<string>(), feeds = new Set<string>();
    const addRef = (ref: string, set?: Set<string>) => { const parsed = parseTransitRef(ref); if (!parsed) return; feeds.add(parsed.feed); if (parsed.feed === feed?.feedId) set?.add(parsed.id); };
    const addTrip = (ref: string, shards: ScheduleShard[], board?: number, alight?: number) => {
      const instance = parseTransitRef(ref);
      if (!instance || instance.kind !== 'trip' || !('serviceDate' in instance)) return false;
      const match = matchTripInstance({ entityId: 'scope', tripId: instance.id, startDate: instance.serviceDate, startTime: instance.startTime,
        scheduleRelationship: 'SCHEDULED', rawScheduleRelationship: 0, stops: [] }, { manifest: data.manifest, version: data.version, shards, feedId: instance.feed });
      if (!match || match.tripInstanceRef !== ref) return false;
      addRef(ref, tripIds); addRef(match.trip.routeRef, routeIds);
      for (const call of match.trip.stopTimes) if ((board === undefined || call.sequence >= board) && (alight === undefined || call.sequence <= alight)) addRef(call.stopRef, stopIds);
      return true;
    };
    if (parsed && parsed.kind !== 'trip') {
      addRef(args.ref!, parsed.kind === 'route' ? routeIds : parsed.kind === 'stop' ? stopIds : undefined);
      const index = data.indexes.find(index => index.feedId === parsed.feed);
      const routes = index?.routes.filter(route => parsed.kind === 'route' ? route.ref === args.ref : parsed.kind === 'agency' ? route.agencyRef === args.ref : index.stopRoutes[asTransitRef(args.ref!)]?.includes(route.ref)) ?? [];
      for (const route of routes) addRef(route.ref, routeIds);
      if (parsed.kind !== 'stop') for (const [stop, refs] of Object.entries(index?.stopRoutes ?? {})) if (refs.some(ref => routes.some(route => route.ref === ref))) addRef(stop, stopIds);
    }
    if (parsed?.kind === 'trip' && 'serviceDate' in parsed && typeof parsed.serviceDate === 'string') {
      const day = parsed.serviceDate, instant = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T12:00:00Z`;
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant, windowSeconds: 86400, feedIds: [parsed.feed] });
      if (!addTrip(args.ref!, schedule.shards.map(item => item.shard))) throw new TransitToolError('ENTITY_NOT_FOUND');
    }
    const legChecks: { index: number; valid: boolean; reasons: string[] }[] = [];
    const transferChecks: { fromLegIndex: number; toLegIndex: number; valid: false; reasons: string[] }[] = [];
    let journeyValid: boolean | null = null, journeyReasons: string[] = [];
    if (args.itinerary) {
      const itinerary = args.itinerary;
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant: itinerary.departAt, windowSeconds: itinerary.windowSeconds });
      for (const leg of itinerary.legs) if (leg.kind === 'transit') addTrip(leg.tripInstanceRef, schedule.shards.map(item => item.shard), leg.boardSequence, leg.alightSequence);
      const realtime = await readFeed<NormalizedStopUpdate>(context, data, 'trip_updates', nowSeconds, handler.mcpReq.signal);
      if (realtime) sources.push(...realtimeSource(data, realtime, 'trip_updates', nowSeconds));
      const validation = await validateItinerary(itinerary as Parameters<typeof validateItinerary>[0], { manifest: data.manifest, shards: schedule.shards.map(item => item.shard), now,
        realtimeMaxAgeSeconds: data.coverage.thresholds.tripUpdates.realtimeSeconds,
        realtime: realtime?.version && realtime.receivedAtSeconds !== undefined ? { ...realtime, version: realtime.version, receivedAtSeconds: realtime.receivedAtSeconds } : undefined }, handler.mcpReq.signal);
      journeyValid = validation.valid; journeyReasons = validation.reasons;
      itinerary.legs.forEach((_leg, index) => {
        const reasons = validation.legFailures.find(failure => failure.index === index)?.reasons ?? [];
        legChecks.push({ index, valid: reasons.length === 0, reasons });
      });
      transferChecks.push(...validation.transferFailures.map(failure => ({ ...failure, valid: false as const })));
    }
    const inFeed = !!args.coverage || !!feed && feeds.has(feed.feedId);
    const usable = inFeed && feed?.payload !== null && feed?.payload !== undefined;
    const alerts = (feed?.payload ?? []).filter(alert => {
      if (!inFeed) return false;
      if (args.coverage || !alert.routeIds.length && !alert.stopIds.length && !alert.tripIds?.length) return true;
      return alert.routeIds.some(id => routeIds.has(id)) || alert.stopIds.some(id => stopIds.has(id)) || !!alert.tripIds?.some(id => tripIds.has(id));
    })
      .map(alert => ({ id: alert.id, agencyText: { title: sanitizeTransitText(alert.header), description: sanitizeTransitText(alert.description), label: 'agency_supplied' as const },
        routeIds: alert.routeIds, stopIds: alert.stopIds, stale: feed?.freshness !== 'fresh' }));
    return complete({ ...meta, sources,
      status: usable ? 'realtime' as const : 'unavailable' as const, reasons: usable ? [] : ['REALTIME_UNAVAILABLE' as const], alerts, journeyValid, journeyReasons, legChecks, transferChecks });
  }, () => complete({ ...unavailable(args.coverage), alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] })));
}
