import { describe, expect, it } from 'vitest';
import { serviceDaysForInstant, serviceInstant } from '../../src/transit/planner/service-day';

describe('GTFS service days', () => {
  // Catch using midnight or a fixed UTC offset instead of local noon minus 12h.
  it.each([
    ['2026-03-08T01:30:00-08:00', '20260308', '2026-03-07T23:00:00-08:00', 9000],
    ['2026-03-08T03:30:00-07:00', '20260308', '2026-03-07T23:00:00-08:00', 12600],
    ['2026-11-01T01:30:00-07:00', '20261101', '2026-11-01T01:00:00-07:00', 1800],
    ['2026-11-01T01:30:00-08:00', '20261101', '2026-11-01T01:00:00-07:00', 5400],
  ])('resolves %s against the correct service-day origin', async (instant, serviceDate, startTime, elapsedSeconds) => {
    expect(serviceDaysForInstant(instant, 'America/Los_Angeles')).toContainEqual({ serviceDate, startTime, elapsedSeconds });
  });

  it('keeps the previous day at local midnight and supports a feed-derived >48h bound', async () => {
    expect(serviceDaysForInstant('2026-10-19T00:00:00-07:00', 'America/Los_Angeles', 49 * 3600))
      .toEqual([
        { serviceDate: '20261017', startTime: '2026-10-17T00:00:00-07:00', elapsedSeconds: 172800 },
        { serviceDate: '20261018', startTime: '2026-10-18T00:00:00-07:00', elapsedSeconds: 86400 },
        { serviceDate: '20261019', startTime: '2026-10-19T00:00:00-07:00', elapsedSeconds: 0 },
      ]);
  });

  it('includes the next civil service date when its spring-forward origin has begun', async () => {
    expect(serviceDaysForInstant('2026-03-07T23:30:00-08:00', 'America/Los_Angeles', 3600))
      .toEqual([{ serviceDate: '20260308', startTime: '2026-03-07T23:00:00-08:00', elapsedSeconds: 1800 }]);
  });

  it('interprets non-hour IANA offsets and rejects ambiguous or invalid inputs', async () => {
    expect(serviceInstant('20261019', 3600, 'Asia/Kathmandu')).toBe('2026-10-19T01:00:00+05:45');
    expect(() => serviceDaysForInstant('2026-10-19T12:00:00', 'America/Los_Angeles')).toThrow(/offset/i);
    expect(() => serviceDaysForInstant('2026-02-30T12:00:00Z', 'UTC')).toThrow(/instant/i);
    expect(() => serviceDaysForInstant('2026-10-19T12:00:00Z', 'MadeUp/Zone')).toThrow(/timezone/i);
  });
});
