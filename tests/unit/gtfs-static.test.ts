import { describe, expect, it } from 'vitest';
import { parseGtfsCsv } from '../../src/transit/gtfs/static/csv';
import { parseGtfsTime } from '../../src/transit/gtfs/static/time';
import { encodeTransitId, transitResourceUri } from '../../src/regions/ids';
import { routeTypeToMode } from '../../src/transit/gtfs/static/modes';

describe('GTFS static primitives', () => {
  it('parses RFC 4180 rows with BOM, CRLF, commas, quotes, and newlines', () => {
    const csv = '\uFEFFstop_id,stop_name,desc\r\nA,"Market, Street","Line 1\r\nLine 2"\r\nB,"He said ""go""",\r\n';
    expect(parseGtfsCsv(csv)).toEqual([
      { stop_id: 'A', stop_name: 'Market, Street', desc: 'Line 1\r\nLine 2' },
      { stop_id: 'B', stop_name: 'He said "go"', desc: '' },
    ]);
  });

  it('rejects duplicate headers and rows with the wrong width', () => {
    expect(() => parseGtfsCsv('id,id\n1,2\n')).toThrow('Duplicate GTFS header');
    expect(() => parseGtfsCsv('id,name\n1\n')).toThrow('columns');
  });

  it('parses service times past midnight without normalizing them away', () => {
    expect(parseGtfsTime('00:00:00')).toEqual({ hours: 0, minutes: 0, seconds: 0, totalSeconds: 0 });
    expect(parseGtfsTime('25:30:05')).toEqual({ hours: 25, minutes: 30, seconds: 5, totalSeconds: 91805 });
    expect(() => parseGtfsTime('12:60:00')).toThrow('Invalid GTFS time');
  });

  it('preserves case-sensitive ids and percent-encodes resource segments', () => {
    expect(encodeTransitId('Ab:c /%')).toBe('Ab:c /%');
    expect(transitResourceUri('sfbay', 'stops', 'Ab:c /%')).toBe('transit://stops/sfbay/Ab%3Ac%20%2F%25');
  });

  it('maps standard and extended route types and rejects unknown values', () => {
    expect(routeTypeToMode(0)).toBe('tram');
    expect(routeTypeToMode(1)).toBe('subway');
    expect(routeTypeToMode(2)).toBe('rail');
    expect(routeTypeToMode(3)).toBe('bus');
    expect(routeTypeToMode(4)).toBe('ferry');
    expect(routeTypeToMode(5)).toBe('cable_tram');
    expect(routeTypeToMode(11)).toBe('trolleybus');
    expect(routeTypeToMode(100)).toBe('rail');
    expect(() => routeTypeToMode(99)).toThrow('Unsupported GTFS route_type');
  });
});
