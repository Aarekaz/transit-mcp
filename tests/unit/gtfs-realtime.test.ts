import { describe, expect, it } from 'vitest';
import { classifyFreshness, sanitizeTransitText } from '../../src/transit/gtfs/realtime/freshness';
import { allocatePollIntervals } from '../../src/transit/gtfs/upstream/budget';
import { buildUpstreamRequest, redactUpstreamUrl } from '../../src/transit/gtfs/upstream/request';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { decodeRealtimeFeed } from '../../src/transit/gtfs/realtime/decode';
import { RegionalFeedHubCore } from '../../src/transit/gtfs/realtime/hub-core';
import { pollAttemptState, safePollFailureReason } from '../../src/transit/gtfs/realtime/region-feed-hub';

describe('GTFS realtime policy', () => {
  it('classifies producer timestamps without refreshing restored snapshots', () => {
    const now = 1_000_000;
    expect(classifyFreshness(null, now, 120)).toBe('unavailable');
    expect(classifyFreshness(now - 270, now, 120)).toBe('fresh');
    expect(classifyFreshness(now - 271, now, 120)).toBe('stale');
    expect(classifyFreshness(now - 480, now, 120)).toBe('stale');
    expect(classifyFreshness(now - 481, now, 120)).toBe('expired');
  });

  it('strips markup, controls, and bounds untrusted operator text', () => {
    expect(sanitizeTransitText('<script>ignore</script><b>Delay</b>\u0000 now', 20))
      .toBe('ignoreDelay now');
    expect(sanitizeTransitText('x'.repeat(50), 10)).toBe('xxxxxxxxxx');
  });

  it('allocates a fixed upstream budget independent of user traffic', () => {
    const intervals = allocatePollIntervals({
      requestsPerHour: 60,
      safetyFactor: 0.8,
      reserveForStatic: 1,
      feeds: [
        { id: 'tu', weight: 5, minIntervalSeconds: 120 },
        { id: 'vp', weight: 2, minIntervalSeconds: 300 },
        { id: 'alerts', weight: 1, minIntervalSeconds: 900 },
      ],
    });
    expect(intervals).toEqual({ tu: 120, vp: 300, alerts: 900 });
    const requests = Object.values(intervals).reduce((total, seconds) => total + 3600 / seconds, 1);
    expect(requests).toBeLessThanOrEqual(48);
  });

  it('adds the 511 credential only at the upstream boundary and redacts it', () => {
    const request = buildUpstreamRequest(
      new URL('https://api.511.org/transit/tripupdates?agency=RG'),
      'top-secret',
    );
    expect(request.url).toContain('api_key=top-secret');
    expect(request.headers.get('accept')).toBe('application/x-google-protobuf');
    expect(redactUpstreamUrl(request.url)).toBe(
      'https://api.511.org/transit/tripupdates?agency=RG&api_key=%5BREDACTED%5D',
    );
  });

  it('decodes trip updates, vehicles, and sanitized alerts into bounded records', () => {
    const bytes = transit_realtime.FeedMessage.encode({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1_000 },
      entity: [
        {
          id: 'trip-entity',
          tripUpdate: {
            trip: { tripId: 'trip-1', routeId: 'route-1' },
            stopTimeUpdate: [{
              stopId: 'stop-1',
              arrival: { time: 1_060 },
            }],
          },
        },
        {
          id: 'vehicle-entity',
          vehicle: {
            trip: { tripId: 'trip-1', routeId: 'route-1' },
            vehicle: { id: 'vehicle-1', label: 'Train 1' },
            position: { latitude: 37.77, longitude: -122.42 },
            timestamp: 1_005,
          },
        },
        {
          id: 'alert-entity',
          alert: {
            informedEntity: [{ routeId: 'route-1' }],
            headerText: { translation: [{ text: '<b>Delay</b>' }] },
            descriptionText: { translation: [{ text: 'Use alternate service' }] },
          },
        },
      ],
    }).finish();

    const feed = decodeRealtimeFeed(bytes);
    expect(feed.producerTimestampSeconds).toBe(1_000);
    expect(feed.tripUpdates[0]).toMatchObject({ tripId: 'trip-1', stopId: 'stop-1', arrivalTimeSeconds: 1_060 });
    expect(feed.vehicles[0]?.vehicleId).toBe('vehicle-1');
    expect(feed.vehicles[0]?.latitude).toBeCloseTo(37.77, 4);
    expect(feed.vehicles[0]?.longitude).toBeCloseTo(-122.42, 4);
    expect(feed.alerts[0]).toMatchObject({ id: 'alert-entity', header: 'Delay', routeIds: ['route-1'] });
    expect(() => decodeRealtimeFeed(new Uint8Array([255]))).toThrow('Malformed GTFS-Realtime feed');
  });

  it('serves snapshots without extending producer freshness or fetching upstream', () => {
    const hub = new RegionalFeedHubCore({ trip_updates: 120, vehicle_positions: 300, service_alerts: 900 });
    hub.replace('trip_updates', {
      producerTimestampSeconds: 1_000,
      receivedAtSeconds: 1_010,
      payload: { arrivals: 3 },
      warnings: ['empty_feed'],
    });

    expect(hub.read('trip_updates', 1_270)).toMatchObject({ freshness: 'fresh', payload: { arrivals: 3 }, warnings: ['empty_feed'] });
    expect(hub.read('trip_updates', 1_271)).toMatchObject({ freshness: 'stale' });
    expect(hub.read('trip_updates', 1_271).warnings).toEqual(expect.arrayContaining(['empty_feed', 'stale_feed']));
    expect(hub.read('trip_updates', 1_481)).toMatchObject({ freshness: 'expired', payload: null, warnings: ['expired_feed'] });
    expect(hub.read('vehicle_positions', 1_000)).toMatchObject({ freshness: 'unavailable', payload: null });
  });

  it('accounts failed attempts against quota and never logs credential-bearing errors', () => {
    expect(pollAttemptState('trip_updates', 1234)).toEqual({ 'polled:trip_updates': 1234 });
    expect(safePollFailureReason(new Error('fetch https://api.511.org/?api_key=secret failed'))).toBe('upstream_request_failed');
    expect(safePollFailureReason(new Error('upstream_body_too_large'))).toBe('upstream_body_too_large');
    expect(safePollFailureReason(new Error('Malformed GTFS-Realtime feed'))).toBe('malformed_feed');
  });
});
