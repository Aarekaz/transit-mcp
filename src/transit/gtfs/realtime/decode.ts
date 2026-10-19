import { transit_realtime } from 'gtfs-realtime-bindings';
import { sanitizeTransitText } from './freshness';

export interface NormalizedStopUpdate {
  entityId: string;
  tripId?: string;
  routeId?: string;
  stopId: string;
  stopSequence?: number;
  arrivalTimeSeconds?: number;
  departureTimeSeconds?: number;
  arrivalDelaySeconds?: number;
  departureDelaySeconds?: number;
  stopScheduleRelationship?: StopRelationship;
  scheduleRelationship?: TripRelationship;
  tripInstanceRef?: string;
  serviceDate?: string;
  scheduledArrivalTimeSeconds?: number;
  scheduledDepartureTimeSeconds?: number;
  status?: 'realtime' | 'scheduled_only' | 'canceled' | 'skipped';
  /** Absent or `matched`: a call of a canonical scheduled trip instance. `unscheduled_call`:
   * an observed stop outside the matched trip's pattern (a reroute). `unmatched_trip`: an
   * observed train with no canonical schedule. Neither has a scheduled time. */
  scheduleMatch?: 'matched' | 'unscheduled_call' | 'unmatched_trip';
  /** Last reported stop of the observed train, for unscheduled rows only. */
  destinationStopId?: string;
}

export type TripRelationship = 'SCHEDULED' | 'ADDED' | 'UNSCHEDULED' | 'CANCELED' | 'REPLACEMENT' | 'DUPLICATED' | 'UNKNOWN';
export type StopRelationship = 'SCHEDULED' | 'SKIPPED' | 'NO_DATA' | 'UNSCHEDULED' | 'UNKNOWN';
export interface DecodedStopUpdate extends Omit<NormalizedStopUpdate, 'stopId'> { stopId?: string }
export interface NormalizedTripUpdate {
  entityId: string; tripId?: string; routeId?: string; startDate?: string; startTime?: string;
  scheduleRelationship: TripRelationship; rawScheduleRelationship: number;
  delaySeconds?: number; stops: DecodedStopUpdate[];
  tripProperties?: { tripId?: string; startDate?: string; startTime?: string };
}

export type VehicleStopStatus = 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';

export interface NormalizedVehicle {
  entityId: string;
  vehicleId?: string;
  label?: string;
  tripId?: string;
  startDate?: string;
  startTime?: string;
  scheduleRelationship?: TripRelationship;
  tripInstanceRef?: string;
  routeId?: string;
  /** Absent when the producer reports only a stop (NYCT publishes no coordinates). */
  latitude?: number;
  longitude?: number;
  /** The stop the vehicle is at or heading to, as the producer reports it. */
  stopId?: string;
  currentStatus?: VehicleStopStatus;
  /** Set by schedule matching: headsign and the stop served before `stopId`. */
  headsign?: string;
  previousStopId?: string;
  bearing?: number;
  speedMetersPerSecond?: number;
  timestampSeconds?: number;
  observationAgeSeconds?: number | null;
  status?: 'realtime' | 'unavailable';
}

export interface NormalizedAlert {
  id: string;
  header: string;
  description: string;
  routeIds: string[];
  stopIds: string[];
  tripIds?: string[];
  /** Conjunction within one selector; alternatives between selectors. */
  selectors: NormalizedAlertSelector[];
  /** Empty means always active; otherwise alternatives with open interval ends. */
  activePeriods?: { start?: number; end?: number }[];
}
export interface NormalizedAlertSelector {
  agencyId?: string; routeId?: string; routeType?: number; stopId?: string; directionId?: number;
  trip?: { tripId?: string; startDate?: string; startTime?: string; routeId?: string; directionId?: number };
}

export interface NormalizedRealtimeFeed {
  producerTimestampSeconds?: number;
  tripUpdates: NormalizedStopUpdate[];
  trips: NormalizedTripUpdate[];
  vehicles: NormalizedVehicle[];
  alerts: NormalizedAlert[];
  warnings: string[];
}

function numberValue(value: number | { toString(): string } | null | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Protobuf defaults live on the prototype: absent timestamps/delays must remain absent.
function ownNumber(object: object | null | undefined, key: string): number | undefined {
  return object && Object.hasOwn(object, key) ? numberValue((object as Record<string, number>)[key]) : undefined;
}

function identifier(value: string | null | undefined): string | undefined {
  // IDs are never rewritten: doing so could alias two provider entities.
  return value && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

export function safeAlertIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[<>\u0000-\u001f\u007f]/.test(value);
}
export function safeAlertSelector(selector: NormalizedAlertSelector): boolean {
  return [selector.agencyId, selector.routeId, selector.stopId, selector.trip?.tripId, selector.trip?.routeId,
    selector.trip?.startDate, selector.trip?.startTime].every(value => value === undefined || safeAlertIdentifier(value)) &&
    [selector.routeType, selector.directionId, selector.trip?.directionId].every(value => value === undefined || Number.isSafeInteger(value) && value >= 0);
}

function alertSelector(value: transit_realtime.IEntitySelector): NormalizedAlertSelector {
  const selector: NormalizedAlertSelector = {};
  // Preserve presence: protobuf defaults must not create constraints, and an
  // explicitly empty/invalid identifier must not become a general selector.
  for (const key of ['agencyId', 'routeId', 'stopId'] as const) if (Object.hasOwn(value, key)) selector[key] = value[key] ?? '';
  for (const key of ['routeType', 'directionId'] as const) { const number = ownNumber(value, key); if (number !== undefined) selector[key] = number; }
  if (value.trip) {
    selector.trip = {};
    for (const key of ['tripId', 'startDate', 'startTime', 'routeId'] as const) if (Object.hasOwn(value.trip, key)) selector.trip[key] = value.trip[key] ?? '';
    const direction = ownNumber(value.trip, 'directionId'); if (direction !== undefined) selector.trip.directionId = direction;
    // GTFS explicitly ignores schedule_relationship in alert TripDescriptors.
  }
  return selector;
}

function firstTranslation(value: transit_realtime.ITranslatedString | null | undefined): string {
  const text = value?.translation?.find(item => item.text)?.text ?? '';
  return sanitizeTransitText(text, 2_000);
}

/** Wire type each GTFS-Realtime Alert field must use (0 varint, 2 length-delimited). */
const ALERT_WIRE_TYPES: Record<number, number> = { 1: 2, 5: 2, 6: 0, 7: 0, 8: 2, 10: 2, 11: 2, 12: 2, 13: 2, 14: 0, 15: 2, 16: 2, 17: 2, 18: 2 };

function readVarint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0, shift = 0;
  for (;;) {
    if (at >= bytes.length || shift > 63) throw new Error('truncated varint');
    const byte = bytes[at++]!;
    value += (byte & 0x7f) * 2 ** shift; shift += 7;
    if (byte < 0x80) return [value, at];
  }
}
function writeVarint(value: number, out: number[]): void {
  while (value >= 0x80) { out.push((value % 0x80) | 0x80); value = Math.floor(value / 0x80); }
  out.push(value);
}
/** Copies a message field by field; `child` rewrites selected length-delimited fields and
 * `keep` drops fields. Returns the number of fields dropped anywhere below. */
function rewriteMessage(bytes: Uint8Array, out: number[], visit: (field: number, wire: number) => 'keep' | 'drop' | ((body: Uint8Array, out: number[]) => number)): number {
  let at = 0, dropped = 0;
  while (at < bytes.length) {
    const start = at, [tag, afterTag] = readVarint(bytes, at), field = Math.floor(tag / 8), wire = tag % 8;
    let end = afterTag, body: Uint8Array | undefined;
    if (wire === 0) end = readVarint(bytes, afterTag)[1];
    else if (wire === 1) end = afterTag + 8;
    else if (wire === 5) end = afterTag + 4;
    else if (wire === 2) { const [length, from] = readVarint(bytes, afterTag); end = from + length; body = bytes.subarray(from, end); }
    else throw new Error('unsupported wire type');
    if (end > bytes.length) throw new Error('truncated field');
    at = end;
    const action = visit(field, wire);
    if (action === 'drop') { dropped++; continue; }
    if (action === 'keep' || !body) { for (let i = start; i < end; i++) out.push(bytes[i]!); continue; }
    const inner: number[] = [];
    dropped += action(body, inner);
    writeVarint(tag, out); writeVarint(inner.length, out); for (const byte of inner) out.push(byte);
  }
  return dropped;
}
/** WMATA has published alerts with severity as a varint in field 12, which GTFS-Realtime
 * defines as tts_header_text. Drop only Alert fields whose wire type contradicts the spec. */
function dropMistypedAlertFields(bytes: Uint8Array): { bytes: Uint8Array; dropped: number } {
  const out: number[] = [];
  const alert = (body: Uint8Array, inner: number[]) => rewriteMessage(body, inner, (field, wire) => ALERT_WIRE_TYPES[field] !== undefined && ALERT_WIRE_TYPES[field] !== wire ? 'drop' : 'keep');
  const entity = (body: Uint8Array, inner: number[]) => rewriteMessage(body, inner, (field, wire) => field === 5 && wire === 2 ? alert : 'keep');
  const dropped = rewriteMessage(bytes, out, (field, wire) => field === 2 && wire === 2 ? entity : 'keep');
  return { bytes: Uint8Array.from(out), dropped };
}

export function decodeRealtimeFeed(bytes: Uint8Array): NormalizedRealtimeFeed {
  let message: transit_realtime.FeedMessage, repaired = false;
  try {
    message = transit_realtime.FeedMessage.decode(bytes);
  } catch {
    try {
      const repair = dropMistypedAlertFields(bytes);
      if (repair.dropped === 0) throw new Error('not repairable');
      message = transit_realtime.FeedMessage.decode(repair.bytes);
      repaired = true;
    } catch {
      throw new Error('Malformed GTFS-Realtime feed');
    }
  }

  const feed: NormalizedRealtimeFeed = {
    producerTimestampSeconds: ownNumber(message.header, 'timestamp'),
    tripUpdates: [],
    trips: [],
    vehicles: [],
    alerts: [],
    warnings: repaired ? ['dropped_mistyped_alert_field'] : [],
  };

  if (message.header.incrementality === 1) throw new Error('Unsupported differential GTFS-Realtime feed');
  for (const entity of message.entity) {
    if (entity.isDeleted) { feed.warnings.push('unsupported_deleted_entity'); continue; }
    if (entity.tripUpdate) {
      const update = entity.tripUpdate, descriptor = update.trip;
      const raw = descriptor.scheduleRelationship ?? 0;
      const relationships: Record<number, TripRelationship> = { 0: 'SCHEDULED', 1: 'ADDED', 2: 'UNSCHEDULED', 3: 'CANCELED', 5: 'REPLACEMENT', 6: 'DUPLICATED' };
      const stopRelationships: Record<number, StopRelationship> = { 0: 'SCHEDULED', 1: 'SKIPPED', 2: 'NO_DATA', 3: 'UNSCHEDULED' };
      const trip: NormalizedTripUpdate = { entityId: identifier(entity.id) ?? '', tripId: identifier(descriptor.tripId), routeId: identifier(descriptor.routeId),
        startDate: identifier(descriptor.startDate), startTime: identifier(descriptor.startTime), scheduleRelationship: relationships[raw] ?? 'UNKNOWN',
        rawScheduleRelationship: raw, delaySeconds: ownNumber(update, 'delay'), stops: [],
        ...(update.tripProperties ? { tripProperties: { tripId: identifier(update.tripProperties.tripId), startDate: identifier(update.tripProperties.startDate), startTime: identifier(update.tripProperties.startTime) } } : {}) };
      for (const stop of update.stopTimeUpdate ?? []) {
        const normalized: DecodedStopUpdate = { entityId: trip.entityId, tripId: trip.tripId, routeId: trip.routeId, stopId: identifier(stop.stopId),
          stopSequence: ownNumber(stop, 'stopSequence'), arrivalTimeSeconds: ownNumber(stop.arrival, 'time'), departureTimeSeconds: ownNumber(stop.departure, 'time'),
          arrivalDelaySeconds: ownNumber(stop.arrival, 'delay'), departureDelaySeconds: ownNumber(stop.departure, 'delay'),
          stopScheduleRelationship: stopRelationships[stop.scheduleRelationship ?? 0] ?? 'UNKNOWN' };
        trip.stops.push(normalized);
        if (normalized.stopId) feed.tripUpdates.push({ ...normalized, stopId: normalized.stopId });
      }
      feed.trips.push(trip);
    }

    const vehicle = entity.vehicle;
    const positioned = vehicle?.position?.latitude != null && vehicle.position.longitude != null, stopId = identifier(vehicle?.stopId);
    if (vehicle && (positioned || stopId)) {
      // GTFS-Realtime: an absent current_status with a stop means IN_TRANSIT_TO.
      const statuses: Record<number, VehicleStopStatus> = { 0: 'INCOMING_AT', 1: 'STOPPED_AT', 2: 'IN_TRANSIT_TO' };
      feed.vehicles.push({
        entityId: entity.id,
        vehicleId: vehicle.vehicle?.id ?? undefined,
        label: vehicle.vehicle?.label ? sanitizeTransitText(vehicle.vehicle.label, 120) : undefined,
        tripId: identifier(vehicle.trip?.tripId),
        startDate: identifier(vehicle.trip?.startDate),
        startTime: identifier(vehicle.trip?.startTime),
        scheduleRelationship: vehicle.trip?.scheduleRelationship === 2 ? 'UNSCHEDULED' : vehicle.trip?.scheduleRelationship == null || vehicle.trip.scheduleRelationship === 0 ? 'SCHEDULED' : 'UNKNOWN',
        routeId: identifier(vehicle.trip?.routeId),
        ...(positioned ? { latitude: vehicle.position!.latitude, longitude: vehicle.position!.longitude } : {}),
        ...(stopId ? { stopId, currentStatus: statuses[vehicle.currentStatus ?? 2] } : {}),
        bearing: ownNumber(vehicle.position, 'bearing'),
        speedMetersPerSecond: ownNumber(vehicle.position, 'speed'),
        timestampSeconds: ownNumber(vehicle, 'timestamp'),
      });
    }

    if (entity.alert) {
      const informedEntities = entity.alert.informedEntity ?? [];
      const selectors = informedEntities.map(alertSelector);
      // Some producers (WMATA) encode an open bound as 0. The epoch can never bound a
      // current alert, so 0 is the same open interval as an absent field.
      const bound = (period: transit_realtime.ITimeRange, key: 'start' | 'end') => {
        const value = Object.hasOwn(period, key) ? ownNumber(period, key) : undefined;
        return value === 0 ? {} : Object.hasOwn(period, key) ? { [key]: value } : {};
      };
      const activePeriods = (entity.alert.activePeriod ?? []).map(period => ({ ...bound(period, 'start'), ...bound(period, 'end') }));
      if (!safeAlertIdentifier(entity.id) || selectors.length > 100 || selectors.some(selector => !safeAlertSelector(selector)) || activePeriods.length > 32 ||
        activePeriods.some(period => Object.values(period).some(value => value === undefined || !Number.isSafeInteger(value) || value < 0 || value > 253402300799) ||
          period.start !== undefined && period.end !== undefined && period.end <= period.start)) {
        feed.warnings.push('invalid_alert'); continue;
      }
      feed.alerts.push({
        id: entity.id,
        header: firstTranslation(entity.alert.headerText),
        description: firstTranslation(entity.alert.descriptionText),
        routeIds: [...new Set(informedEntities.flatMap(item => item.routeId ? [item.routeId] : []))],
        stopIds: [...new Set(informedEntities.flatMap(item => item.stopId ? [item.stopId] : []))],
        tripIds: [...new Set(informedEntities.flatMap(item => item.trip?.tripId ? [item.trip.tripId] : []))],
        selectors, activePeriods,
      });
    }
  }

  if (message.entity.length === 0) feed.warnings.push('empty_feed');
  return feed;
}
