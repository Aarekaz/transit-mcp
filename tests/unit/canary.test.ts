import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANARY_KEY, CANARY_STALE_SECONDS, canaryDue, canaryHealthResponse, recordCanary } from '../../src/canary';
import { NOW, bandedArtifact, liveEnv, nowSeconds, upstream, wireHub, feedBytes } from '../helpers/dc-nyc-realtime';
import { NYC_TRIP_FEEDS } from '../../src/regions/nyc';
import { memoryStorage } from '../helpers/realtime-fixture';
import type { Env } from '../../src/types';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('production canary', () => {
  it('runs once every other day, on one five-minute tick', () => {
    const ticks = Array.from({ length: 4 * 24 * 12 }, (_, i) => Date.UTC(2026, 9, 20) + i * 5 * 60_000).filter(canaryDue);
    expect(ticks.map(tick => new Date(tick).toISOString())).toEqual(['2026-10-20T14:00:00.000Z', '2026-10-22T14:00:00.000Z']);
  });

  it('answers 200 only for a recent passing report, with the failures otherwise', async () => {
    const db = memoryStorage(), env = { TRANSIT_ARTIFACTS: db.bucket } as unknown as Env;
    expect((await canaryHealthResponse(env)).status).toBe(503);
    const report = (ok: boolean) => ({ at: new Date(Date.now()).toISOString(), ok, checks: [{ name: 'nyc.plan', ok, ms: 900, detail: ok ? '3 itineraries' : 'no itinerary' }] });
    await db.bucket.put(CANARY_KEY, JSON.stringify({ latest: report(true), history: [] }));
    expect((await canaryHealthResponse(env)).status).toBe(200);
    // The check itself stopped running: that is an outage too.
    expect((await canaryHealthResponse(env, Date.now() + (CANARY_STALE_SECONDS + 60) * 1000)).status).toBe(503);
    await db.bucket.put(CANARY_KEY, JSON.stringify({ latest: report(false), history: [] }));
    const failing = await canaryHealthResponse(env);
    expect(failing.status).toBe(503);
    expect(await failing.json()).toMatchObject({ ok: false, failures: [{ name: 'nyc.plan', detail: 'no itinerary' }] });
  });

  it('calls the tools an agent uses and reports what a rider would miss', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const artifact = await bandedArtifact('nyc');
    const env = liveEnv(artifact.db, { TRANSIT_COVERAGE_MODES: '{"nyc":"on"}' } as never);
    const hub = wireHub(env, artifact.db, 'nyc:mta');
    const stamp = nowSeconds(), documents: Record<string, Uint8Array> = { 'camsys/subway-alerts': feedBytes(stamp, []) };
    for (const id of NYC_TRIP_FEEDS) documents[`nyct/${id}`] = feedBytes(stamp, []);
    vi.spyOn(globalThis, 'fetch').mockImplementation(upstream(documents).fetcher);
    await hub.alarm();
    const report = await recordCanary(env, Date.now(), 0);
    const byName = Object.fromEntries(report.checks.map(item => [item.name, item]));
    // Times Sq exists in the fixture: the board answers.
    expect(byName['nyc.departures']).toMatchObject({ ok: true });
    // The fixture has no Union Sq or Atlantic Av and no M15: those are failures, with the reason.
    expect(byName['nyc.plan']).toMatchObject({ ok: false, detail: expect.stringContaining('ENTITY_NOT_FOUND') });
    expect(byName['nyc.bus']).toMatchObject({ ok: false });
    expect(report.ok).toBe(false);
    // Recorded for /health/deep, with history.
    const health = await (await canaryHealthResponse(env)).json() as { ok: boolean; recent: { failed: string[] }[] };
    expect(health.ok).toBe(false);
    expect(health.recent.at(-1)!.failed).toEqual(expect.arrayContaining(['nyc.plan', 'nyc.bus']));
  });
});
