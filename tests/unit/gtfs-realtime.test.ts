import { describe, expect, it } from 'vitest';
import { classifyFreshness, sanitizeTransitText } from '../../src/transit/gtfs/realtime/freshness';
import { allocatePollIntervals } from '../../src/transit/gtfs/upstream/budget';
import { buildUpstreamRequest, redactUpstreamUrl } from '../../src/transit/gtfs/upstream/request';

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
});
