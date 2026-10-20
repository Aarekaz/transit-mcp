import { describe, expect, it } from 'vitest';
import { blockedStations, decodeEquipmentOutages, stationAccess, stepFreeStops, stopAccess, type EquipmentOutage } from '../../src/transit/accessibility/equipment';
import { formatEntityRef } from '../../src/transit/core/refs';
import type { DiscoveryIndex, ScheduleStop } from '../../src/transit/gtfs/static/schema';
import { planJourney } from '../../src/transit/planner/plan';
import { validateItinerary } from '../../src/transit/planner/validator';
import { NYC_EQUIPMENT, nyctOutage, wmataIncident } from '../helpers/dc-nyc-realtime';
import { plannerFixture, plannerInput, ref } from '../helpers/planner-fixture';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const nycStop = (id: string, locationType: number, parent?: string): ScheduleStop => ({ ref: formatEntityRef({ coverage: 'nyc', feed: 'mta_subway', kind: 'stop', id }), providerId: id, name: id,
  latitude: 40.7, longitude: -74, locationType, wheelchairBoarding: 0, ...parent ? { parentStationRef: formatEntityRef({ coverage: 'nyc', feed: 'mta_subway', kind: 'stop', id: parent }) } : {} });
const nycIndex = (stops: ScheduleStop[]): DiscoveryIndex => ({ schemaVersion: 2, coverageId: 'nyc', feedId: 'mta_subway', sourceSha256: '0'.repeat(64), tripProviderIds: [], stops, routes: [], stopRoutes: {} });

describe('equipment outage reports', () => {
  it('decodes WMATA incidents with Washington times and fails closed on malformed reports', () => {
    const { outages } = decodeEquipmentOutages('wmata_elevator_incidents', { incidents: bytes({ ElevatorIncidents: [wmataIncident('A01X01', 'A01', 'ELEVATOR', 'Garage elevator')] }) });
    expect(outages[0]).toMatchObject({ id: 'A01X01', kind: 'elevator', stationKeys: ['A01'], stationKeyKind: 'wmata_station_code', stationName: '', accessiblePath: true, redundant: null,
      sinceSeconds: Date.parse('2026-10-19T10:00:00Z') / 1000, estimatedReturnSeconds: Date.parse('2026-10-22T03:59:59Z') / 1000 });
    expect(() => decodeEquipmentOutages('wmata_elevator_incidents', { incidents: bytes({ ElevatorIncidents: [{ ...wmataIncident('A01X01', 'A01', 'ELEVATOR', ''), UnitType: 'LIFT' }] }) })).toThrow('Malformed equipment feed');
    expect(() => decodeEquipmentOutages('wmata_elevator_incidents', { incidents: new TextEncoder().encode('<html>') })).toThrow('Malformed equipment feed');
  });

  it('joins NYCT outages to the equipment register, in New York time across DST', () => {
    const { outages, warnings } = decodeEquipmentOutages('nyct_ene', { outages: bytes([nyctOutage('EL132A', { since: '01/15/2027 06:00:00 AM' }), { ...nyctOutage('EL132A'), equipment: 'EL999' }]),
      equipment: bytes(NYC_EQUIPMENT) });
    // January is EST (UTC-5), October EDT (UTC-4).
    expect(outages[0]).toMatchObject({ id: 'EL132A', stationKeys: ['132'], redundant: false, accessiblePath: true, sinceSeconds: Date.parse('2027-01-15T11:00:00Z') / 1000 });
    // An unregistered unit is kept and reported, never placed on a station.
    expect(outages[1]).toMatchObject({ id: 'EL999', stationKeys: [], redundant: null });
    expect(warnings).toEqual(['unregistered_equipment']);
    expect(() => decodeEquipmentOutages('nyct_ene', { outages: bytes([]) })).toThrow('Malformed equipment feed');
  });

  it('blocks a station for a non-redundant ADA elevator, or for two that back each other up', () => {
    const index = nycIndex([nycStop('132', 1), nycStop('127', 1), nycStop('725', 1)]);
    const outage = (id: string, keys: string[], redundant: boolean | null, kind: EquipmentOutage['kind'] = 'elevator'): EquipmentOutage => ({ id, kind, stationKeys: keys, stationKeyKind: 'gtfs_station',
      stationName: '', location: '', accessiblePath: kind === 'elevator', redundant, reason: '', sinceSeconds: 0, estimatedReturnSeconds: null, upcoming: false, alternativeRoute: null });
    const blocked = (outages: EquipmentOutage[]) => [...blockedStations(outages, index, 1)].map(ref => ref.split(':').at(-1)).map(id => atob(id!)).sort();
    expect(blocked([outage('A', ['132'], false)])).toEqual(['132']);
    expect(blocked([outage('B', ['127', '725'], true)])).toEqual([]);
    expect(blocked([outage('B', ['127', '725'], true), outage('C', ['725', '127'], true)])).toEqual(['127', '725']);
    expect(blocked([outage('D', ['132'], false, 'escalator')])).toEqual([]);
  });
});

describe('station step-free access', () => {
  it('reads NYCT partial accessibility by platform direction', () => {
    // MTA: Hoyt St (233) is accessible outbound (southbound) only.
    const stops = [nycStop('233', 1), nycStop('233N', 0, '233'), nycStop('233S', 0, '233'), nycStop('129', 1), nycStop('129S', 0, '129')];
    const index = nycIndex(stops), byRef = new Map(stops.map(stop => [stop.ref as string, stop]));
    expect(stops.map(stop => stopAccess(index, stop, byRef))).toEqual(['unknown', 'not_accessible', 'accessible', 'not_accessible', 'not_accessible']);
    expect(stationAccess(index, stops[0]!, byRef)).toBe('partial');
    expect([...stepFreeStops(index, [], 1)]).toEqual([stops[2]!.ref]);
  });
});

describe('step-free journeys', () => {
  it('routes and validates only through usable stops, independently', async () => {
    const f = await plannerFixture();
    const plain = await planJourney(f.query);
    expect(plain.candidates).toHaveLength(1);
    const usable = new Set([ref('stop', 'A'), ref('stop', 'C')]);
    expect((await planJourney({ ...f.query, stepFree: { usableStopRefs: usable } })).candidates).toHaveLength(1);
    expect((await planJourney({ ...f.query, stepFree: { usableStopRefs: new Set([ref('stop', 'A')]) } })).candidates).toEqual([]);
    // The validator rejects the same itinerary on its own when the destination is not usable.
    const checked = await validateItinerary(plain.candidates[0]!, { ...f.source, stepFree: { usableStopRefs: new Set([ref('stop', 'A')]) } });
    expect(checked).toMatchObject({ valid: false, reasons: ['STEP_FREE'] });
  });

  it('never rides a trip marked not wheelchair accessible', async () => {
    const input = plannerInput();
    input.files['trips.txt'] = 'route_id,service_id,trip_id,trip_headsign,direction_id,block_id,wheelchair_accessible\nR,D,T,Destination,0,,2\n';
    const f = await plannerFixture(input);
    expect((await planJourney(f.query)).candidates).toHaveLength(1);
    expect((await planJourney({ ...f.query, stepFree: { usableStopRefs: new Set([ref('stop', 'A'), ref('stop', 'C')]) } })).candidates).toEqual([]);
  });
});
