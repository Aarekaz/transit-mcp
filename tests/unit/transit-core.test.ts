import { describe, expect, it } from 'vitest';
import * as refs from '../../src/transit/core/refs';
import * as results from '../../src/transit/core/results';

describe('global transit references', () => {
  it('encodes punctuation and Unicode without changing the feed namespace', () => {
    expect(refs.formatEntityRef({ coverage: 'sfbay', feed: 'sf511', kind: 'stop', id: 'a:b/c?' })).toBe('tr:sfbay:sf511:stop:YTpiL2M_');
    const unicode = refs.formatEntityRef({ coverage: 'sfbay', feed: 'sf511', kind: 'route', id: '線 🚈' });
    expect(unicode).toMatch(/^tr:sfbay:sf511:route:[A-Za-z0-9_-]+$/);
    expect(refs.parseTransitRef(unicode)).toEqual({ coverage: 'sfbay', feed: 'sf511', kind: 'route', id: '線 🚈' });
  });

  it('parses entity references without rewriting provider IDs', () => {
    expect(refs.parseTransitRef('tr:sfbay:sf511:agency:Ukc')).toEqual({ coverage: 'sfbay', feed: 'sf511', kind: 'agency', id: 'RG' });
    expect(refs.parseTransitRef('tr:sfbay:sf511:trip:OTE')).toEqual({ coverage: 'sfbay', feed: 'sf511', kind: 'trip', id: '91' });
  });

  it('answers a repeated reference the same way, with a result no caller can change', () => {
    const first = refs.parseTransitRef('tr:sfbay:sf511:stop:OTE')!;
    expect(refs.parseTransitRef('tr:sfbay:sf511:stop:OTE')).toBe(first);
    expect(() => { (first as { id: string }).id = '92'; }).toThrow(TypeError);
    expect(refs.parseTransitRef('tr:sfbay:sf511:stop:OTE')).toEqual({ coverage: 'sfbay', feed: 'sf511', kind: 'stop', id: '91' });
    expect([refs.parseTransitRef('tr:sfbay:sf511:stop:OTF'), refs.parseTransitRef('tr:sfbay:sf511:stop:OTF')]).toEqual([null, null]);
  });

  it('preserves a leading Unicode BOM in opaque provider IDs', () => {
    const ref = refs.formatEntityRef({ coverage: 'sfbay', feed: 'sf511', kind: 'stop', id: '\uFEFF91' });
    expect(refs.parseTransitRef(ref)?.id).toBe('\uFEFF91');
  });

  it('rejects invalid Unicode instead of silently replacing provider identity', () => {
    expect(() => refs.formatEntityRef({ coverage: 'sfbay', feed: 'sf511', kind: 'stop', id: '\uD800' })).toThrow('Invalid transit reference');
  });

  it('distinguishes trips by service date and GTFS start time beyond midnight', () => {
    const input = { coverage: 'sfbay', feed: 'sf511', id: '91', serviceDate: '20261018', startTime: '25:10:00' };
    expect(refs.formatTripInstanceRef(input)).toBe('tr:sfbay:sf511:trip:OTE:20261018:MjU6MTA6MDA');
    expect(refs.parseTransitRef('tr:sfbay:sf511:trip:OTE:20261018:MjU6MTA6MDA')).toEqual({ ...input, kind: 'trip' });
    expect(refs.formatTripInstanceRef({ ...input, serviceDate: '20261019' })).not.toBe(refs.formatTripInstanceRef(input));
  });

  it.each([
    '91', 'tr:SF:sf511:stop:OTE', 'tr:sf-bay:sf511:stop:OTE',
    'tr:sfbay::stop:OTE', 'tr:sfbay:sf511:vehicle:OTE',
    'tr:sfbay:sf511:stop:', 'tr:sfbay:sf511:stop:OTE=',
    'tr:sfbay:sf511:stop:OTF', 'tr:sfbay:sf511:stop:_w',
    'tr:sfbay:sf511:stop:OTE:extra',
    'tr:sfbay:sf511:stop:OTE:20261018:MjU6MTA6MDA',
    'tr:sfbay:sf511:trip:OTE:20260230:MjU6MTA6MDA',
    'tr:sfbay:sf511:trip:OTE:20261018:MjU6NjA6MDA',
    'tr:sfbay:sf511:trip:OTE:20261018:',
  ])('rejects malformed or noncanonical reference %s', (ref) => {
    expect(refs.parseTransitRef(ref)).toBeNull();
  });

  it('rejects invalid formatting inputs with a fixed error that cannot echo provider text', () => {
    expect(() => refs.formatEntityRef({ coverage: 'SF', feed: 'secret:injected', kind: 'stop', id: '91' })).toThrow('Invalid transit reference');
    expect(() => refs.formatEntityRef({ coverage: 'sfbay', feed: 'sf511', kind: 'stop', id: '' })).toThrow('Invalid transit reference');
    expect(() => refs.formatTripInstanceRef({ coverage: 'sfbay', feed: 'sf511', id: '91', serviceDate: '20260229', startTime: '12:00:00' })).toThrow('Invalid transit reference');
  });

  it('returns every exact match for bare 91 across feeds without selecting an operator', () => {
    const candidates = [
      { ref: 'tr:national:amtrak:trip:OTE' as const, providerId: '91', name: 'Silver Star' },
      { ref: 'tr:sfbay:sf511:route:OTE' as const, providerId: '91', name: '91 Owl' },
      { ref: 'tr:sfbay:other_feed:route:OTI' as const, providerId: '92', name: '91' },
      { ref: 'tr:sfbay:sf511:route:MTkx' as const, providerId: '191', name: 'Other' },
    ];
    const found = refs.findTransitCandidates(' 91 ', candidates);
    expect(found.map(candidate => candidate.ref)).toEqual([
      'tr:national:amtrak:trip:OTE', 'tr:sfbay:other_feed:route:OTI', 'tr:sfbay:sf511:route:OTE',
    ]);
    expect(refs.findTransitCandidates('91', [...candidates].reverse())).toEqual(found);
    expect(refs.findTransitCandidates('silver STAR', candidates)).toEqual([candidates[0]]);
    expect(refs.findTransitCandidates('', candidates)).toEqual([]);
  });
});

describe('result reasons', () => {
  it.each(['REALTIME_STALE', 'REALTIME_UNAVAILABLE', 'SCHEDULE_EXPIRED', 'SCHEDULE_REALTIME_MISMATCH', 'TRIP_CANCELED', 'STOP_SKIPPED', 'VALIDATOR_REJECTED', 'COVERAGE_UNAVAILABLE'])('accepts the fixed reason %s', reason => {
    expect(results.isVerificationReason(reason)).toBe(true);
  });

  it.each(['upstream failed: api_key=secret', '<script>bad</script>', 'realtime_stale', '', null, {}])('rejects arbitrary upstream text and values as reasons: %s', reason => {
    expect(results.isVerificationReason(reason)).toBe(false);
  });
});
