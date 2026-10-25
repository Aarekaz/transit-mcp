import { z } from 'zod';
import { NYC_STATION_ADA } from '../../regions/nyc-ada';
import { formatEntityRef, parseTransitRef } from '../core/refs';
import { sanitizeTransitText } from '../gtfs/realtime/freshness';
import type { FeedIndex, ScheduleStop } from '../gtfs/static/schema';
import { formatInstant } from '../planner/service-day';

/** One elevator or escalator out of service, as the agency reports it. */
export interface EquipmentOutage {
  id: string;
  kind: 'elevator' | 'escalator';
  /** Agency station keys: GTFS station IDs (NYCT) or WMATA station codes (DC). */
  stationKeys: string[];
  stationKeyKind: 'gtfs_station' | 'wmata_station_code';
  stationName: string;
  /** What the unit connects, in the agency's words. */
  location: string;
  /** Part of the step-free path (NYCT ADA flag; WMATA elevators). */
  accessiblePath: boolean;
  /** NYCT: another elevator covers the same path. Null when the agency does not say. */
  redundant: boolean | null;
  reason: string;
  sinceSeconds: number | null;
  estimatedReturnSeconds: number | null;
  /** Announced but not yet started. */
  upcoming: boolean;
  alternativeRoute: string | null;
}
export type EquipmentFormat = 'wmata_elevator_incidents' | 'nyct_ene';

const NEW_YORK = 'America/New_York';
const MAX_RECORDS = 5000;
const text = z.string().max(4000);

/** Agency wall-clock time in the agency's zone to epoch seconds, DST-correct. */
function civilToSeconds(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string): number | null {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(wall)) return null;
  let guess = wall;
  for (let attempt = 0; attempt < 3; attempt++) {
    const offset = /([+-])(\d{2}):(\d{2})$/.exec(formatInstant(guess, timezone));
    if (!offset) return null;
    const minutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
    const next = wall - minutes * 60_000;
    if (next === guess) break;
    guess = next;
  }
  return Math.floor(guess / 1000);
}
/** `12/16/2026 10:00:00 PM` (NYCT). */
function nyctTime(value: string | undefined): number | null {
  const match = value === undefined ? null : /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[4]) % 12 + (match[7] === 'PM' ? 12 : 0);
  return civilToSeconds(Number(match[3]), Number(match[1]), Number(match[2]), hour, Number(match[5]), Number(match[6]), NEW_YORK);
}
/** `2026-06-10T14:20:00` in Washington's zone (WMATA). */
function wmataTime(value: string | null | undefined): number | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value) : null;
  return match ? civilToSeconds(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), NEW_YORK) : null;
}

const wmataIncidents = z.object({ ElevatorIncidents: z.array(z.object({
  UnitName: z.string().regex(/^[A-Z0-9]{1,16}$/), UnitType: z.enum(['ELEVATOR', 'ESCALATOR']), StationCode: z.string().regex(/^[A-Z]\d{2}$/),
  StationName: text.nullable(), LocationDescription: text.nullable(), SymptomDescription: text.nullable(),
  DateOutOfServ: text.nullable(), EstimatedReturnToService: text.nullable(),
})).max(MAX_RECORDS) });
const nyctOutages = z.array(z.object({
  station: text, equipment: z.string().regex(/^[A-Z0-9]{1,16}$/), equipmenttype: z.enum(['EL', 'ES']), serving: text, ADA: z.enum(['Y', 'N']),
  outagedate: text, estimatedreturntoservice: text, reason: text, isupcomingoutage: z.enum(['Y', 'N']),
})).max(MAX_RECORDS);
const nyctEquipment = z.array(z.object({
  equipmentno: z.string().regex(/^[A-Z0-9]{1,16}$/), equipmenttype: z.enum(['EL', 'ES']), ADA: z.enum(['Y', 'N']), isactive: z.enum(['Y', 'N']),
  elevatorsgtfsstopid: z.string().regex(/^([A-Z0-9]{3})(\/[A-Z0-9]{3})*$/), redundant: z.union([z.literal(0), z.literal(1)]), alternativeroute: text.nullable().optional(),
})).max(MAX_RECORDS);

/** Decodes and validates an agency equipment report. Parts are keyed by feed part ID:
 * WMATA sends one document; NYCT sends `outages` and the `equipment` register. */
export function decodeEquipmentOutages(format: EquipmentFormat, parts: Readonly<Record<string, Uint8Array>>): { outages: EquipmentOutage[]; warnings: string[] } {
  const json = (id: string) => {
    const bytes = parts[id];
    if (!bytes) throw new Error('Malformed equipment feed');
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new Error('Malformed equipment feed'); }
  };
  const clean = (value: string | null | undefined, max = 500) => sanitizeTransitText(value ?? '', max);
  if (format === 'wmata_elevator_incidents') {
    const parsed = wmataIncidents.safeParse(json(Object.keys(parts)[0]!));
    if (!parsed.success) throw new Error('Malformed equipment feed');
    return { warnings: [], outages: parsed.data.ElevatorIncidents.map(row => ({
      id: row.UnitName, kind: row.UnitType === 'ELEVATOR' ? 'elevator' : 'escalator', stationKeys: [row.StationCode], stationKeyKind: 'wmata_station_code',
      stationName: clean(row.StationName, 200), location: clean(row.LocationDescription), accessiblePath: row.UnitType === 'ELEVATOR', redundant: null,
      reason: clean(row.SymptomDescription, 200), sinceSeconds: wmataTime(row.DateOutOfServ), estimatedReturnSeconds: wmataTime(row.EstimatedReturnToService),
      upcoming: false, alternativeRoute: null })) };
  }
  const outages = nyctOutages.safeParse(json('outages')), register = nyctEquipment.safeParse(json('equipment'));
  if (!outages.success || !register.success) throw new Error('Malformed equipment feed');
  const units = new Map(register.data.map(unit => [unit.equipmentno, unit]));
  const warnings = new Set<string>();
  const decoded = outages.data.flatMap(row => {
    const unit = units.get(row.equipment);
    // An outage the register cannot place on a station cannot be attributed; report it.
    if (!unit) warnings.add('unregistered_equipment');
    return [{ id: row.equipment, kind: row.equipmenttype === 'EL' ? 'elevator' as const : 'escalator' as const, stationKeys: unit ? unit.elevatorsgtfsstopid.split('/') : [],
      stationKeyKind: 'gtfs_station' as const, stationName: clean(row.station, 200), location: clean(row.serving), accessiblePath: row.ADA === 'Y',
      redundant: unit ? unit.redundant === 1 : null, reason: clean(row.reason, 200), sinceSeconds: nyctTime(row.outagedate), estimatedReturnSeconds: nyctTime(row.estimatedreturntoservice),
      upcoming: row.isupcomingoutage === 'Y', alternativeRoute: unit?.alternativeroute ? clean(unit.alternativeroute, 800) : null }];
  });
  return { outages: decoded, warnings: [...warnings] };
}

/** Current at `nowSeconds`: not announced-only, and started if the agency gave a start. */
export function currentOutage(outage: EquipmentOutage, nowSeconds: number): boolean {
  return !outage.upcoming && (outage.sinceSeconds === null || outage.sinceSeconds <= nowSeconds);
}

/** GTFS station refs (location_type 1) an outage names. */
export function outageStations(outage: EquipmentOutage, index: FeedIndex): string[] {
  const stations = index.stops.filter(stop => stop.locationType === 1);
  if (outage.stationKeyKind === 'gtfs_station') return stations.filter(stop => outage.stationKeys.includes(stop.providerId)).map(stop => stop.ref);
  // WMATA station IDs embed every code they cover: STN_A01_C01 is Metro Center (A01 and C01).
  return stations.filter(stop => /^STN_/.test(stop.providerId) && stop.providerId.slice(4).split('_').some(code => outage.stationKeys.includes(code))).map(stop => stop.ref);
}

export type StopAccess = 'accessible' | 'not_accessible' | 'unknown';
/** Step-free access to a stop from the street, from the authoritative source per coverage:
 * GTFS wheelchair_boarding (inherited from the station when 0), or for NYC MTA's station
 * ADA list by direction (platform suffix N/S), since its GTFS publishes none. */
export function stopAccess(index: FeedIndex, stop: ScheduleStop, stops: ReadonlyMap<string, ScheduleStop>): StopAccess {
  if (index.coverageId === 'nyc') {
    const station = stop.locationType === 1 ? stop : stop.parentStationRef ? stops.get(stop.parentStationRef) : undefined;
    const ada = station ? NYC_STATION_ADA[station.providerId] : undefined;
    if (!ada) return 'unknown';
    if (stop.locationType === 1) return ada[0] === 1 ? 'accessible' : ada[0] === 0 ? 'not_accessible' : 'unknown';
    const direction = stop.providerId.slice(station!.providerId.length);
    const flag = direction === 'N' ? ada[1] : direction === 'S' ? ada[2] : ada[0] === 1 ? 1 : ada[0] === 0 ? 0 : undefined;
    return flag === 1 ? 'accessible' : flag === 0 ? 'not_accessible' : 'unknown';
  }
  const own = stop.wheelchairBoarding || (stop.parentStationRef ? stops.get(stop.parentStationRef)?.wheelchairBoarding ?? 0 : 0);
  return own === 1 ? 'accessible' : own === 2 ? 'not_accessible' : 'unknown';
}

/** A stop's static step-free access; a station summarises its boardable platforms
 * (`partial` when only some are step-free, e.g. one direction). */
export function stationAccess(index: FeedIndex, stop: ScheduleStop, stops: ReadonlyMap<string, ScheduleStop>): StopAccess | 'partial' {
  if (stop.locationType !== 1) return stopAccess(index, stop, stops);
  const platforms = index.stops.filter(child => child.parentStationRef === stop.ref && child.locationType === 0).map(child => stopAccess(index, child, stops));
  if (!platforms.length) return stopAccess(index, stop, stops);
  if (platforms.every(access => access === 'accessible')) return 'accessible';
  if (platforms.some(access => access === 'accessible')) return 'partial';
  return platforms.every(access => access === 'not_accessible') ? 'not_accessible' : 'unknown';
}

/** Stations an outage cuts off from a step-free path. NYCT: a non-redundant ADA
 * elevator, or two or more ADA elevators at the same stations (their backups cannot be
 * paired). WMATA: a station elevator; garage and parking elevators do not reach platforms. */
export function blockedStations(outages: readonly EquipmentOutage[], index: FeedIndex, nowSeconds: number): Set<string> {
  const blocked = new Set<string>(), adaDown = new Map<string, number>();
  for (const outage of outages) {
    if (!currentOutage(outage, nowSeconds) || outage.kind !== 'elevator' || !outage.accessiblePath) continue;
    if (outage.stationKeyKind === 'wmata_station_code') {
      if (!/garage|parking/i.test(outage.location)) for (const ref of outageStations(outage, index)) blocked.add(ref);
      continue;
    }
    const key = [...outage.stationKeys].sort().join('/');
    adaDown.set(key, (adaDown.get(key) ?? 0) + 1);
    if (outage.redundant !== true || adaDown.get(key)! >= 2) for (const ref of outageStations(outage, index)) blocked.add(ref);
  }
  return blocked;
}

/** Boardable stops a step-free journey may use now: step-free from the street by the
 * authoritative source, at a station with no blocking elevator outage. */
export function stepFreeStops(index: FeedIndex, outages: readonly EquipmentOutage[], nowSeconds: number): Set<string> {
  const stops = new Map(index.stops.map(stop => [stop.ref as string, stop]));
  const blocked = blockedStations(outages, index, nowSeconds), usable = new Set<string>();
  for (const stop of index.stops) {
    if (stop.locationType !== 0) continue;
    const station = stop.parentStationRef ?? stop.ref;
    if (!blocked.has(station) && stopAccess(index, stop, stops) === 'accessible') usable.add(stop.ref);
  }
  return usable;
}

/** Station of a stop ref (itself when it is a station). */
export function stationOf(ref: string, stops: ReadonlyMap<string, ScheduleStop>): string {
  const stop = stops.get(ref);
  return stop?.locationType === 1 || !stop?.parentStationRef ? ref : stop.parentStationRef;
}
export const stationRef = (coverage: string, feed: string, id: string) => formatEntityRef({ coverage, feed, kind: 'stop', id });
export const providerIdOf = (ref: string) => parseTransitRef(ref)?.id;
