import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MetroMcpContext } from '../../context';
import { complete, readOnlyLive } from '../../shared';
import { getCoverage } from '../../../transit/core/coverage';
import type { NormalizedAlert, NormalizedStopUpdate } from '../../../transit/gtfs/realtime/decode';
import { sanitizeTransitText } from '../../../transit/gtfs/realtime/freshness';
import { validateItinerary } from '../../../transit/planner/validator';
import { loadScheduleWindow } from '../../../transit/planner/schedule-index';
import { itinerarySchema } from './plan';
import { boundedText, checkState, coverageSchema, guarded, knownEntity, loadData, metadata, readFeed, realtimeSource, resultShape, unavailable, validRef } from './shared';

export function registerServiceStatusTool(server: McpServer, context: MetroMcpContext): void {
  server.registerTool('get_service_status', {
    title: 'Transit service status', description: 'Check disruptions, delays, closures, accessibility alerts or revalidate a chosen itinerary without replacing it. Scope by coverage or an agency, route, stop or dated trip reference. Use get_vehicle_status for an observed vehicle location.',
    annotations: readOnlyLive('Transit service status'),
    inputSchema: z.strictObject({ coverage: coverageSchema.optional(), ref: boundedText.optional(), itinerary: itinerarySchema.optional() }).refine(args => Number(args.coverage !== undefined) + Number(args.ref !== undefined) + Number(args.itinerary !== undefined) === 1, 'Supply exactly one coverage, ref or itinerary.'),
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
    const legChecks: { index: number; valid: boolean; reasons: string[] }[] = [];
    const transferChecks: { fromLegIndex: number; toLegIndex: number; valid: false; reasons: string[] }[] = [];
    let journeyValid: boolean | null = null, journeyReasons: string[] = [];
    if (args.itinerary) {
      const itinerary = args.itinerary;
      const schedule = await loadScheduleWindow({ manifest: data.manifest, readShard: data.readObject, instant: itinerary.departAt, windowSeconds: itinerary.windowSeconds });
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
    const usable = feed?.payload !== null && feed?.payload !== undefined;
    const alerts = (feed?.payload ?? []).filter(alert => {
      if (!parsed || !alert.routeIds.length && !alert.stopIds.length) return true;
      if (parsed.kind === 'route') return alert.routeIds.includes(parsed.id);
      if (parsed.kind === 'stop') return alert.stopIds.includes(parsed.id);
      if (parsed.kind === 'agency') return data.indexes.flatMap(index => index.routes).some(route => route.agencyRef === args.ref && alert.routeIds.includes(route.providerId));
      return true;
    })
      .map(alert => ({ id: alert.id, agencyText: { title: sanitizeTransitText(alert.header), description: sanitizeTransitText(alert.description), label: 'agency_supplied' as const },
        routeIds: alert.routeIds, stopIds: alert.stopIds, stale: feed?.freshness !== 'fresh' }));
    return complete({ ...meta, sources,
      status: usable ? 'realtime' as const : 'unavailable' as const, reasons: usable ? [] : ['REALTIME_UNAVAILABLE' as const], alerts, journeyValid, journeyReasons, legChecks, transferChecks });
  }, () => complete({ ...unavailable(args.coverage), alerts: [], journeyValid: null, journeyReasons: [], legChecks: [], transferChecks: [] })));
}
