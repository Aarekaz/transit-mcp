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

export interface NormalizedVehicle {
  entityId: string;
  vehicleId?: string;
  label?: string;
  tripId?: string;
  routeId?: string;
  latitude: number;
  longitude: number;
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

function firstTranslation(value: transit_realtime.ITranslatedString | null | undefined): string {
  const text = value?.translation?.find(item => item.text)?.text ?? '';
  return sanitizeTransitText(text, 2_000);
}

export function decodeRealtimeFeed(bytes: Uint8Array): NormalizedRealtimeFeed {
  let message: transit_realtime.FeedMessage;
  try {
    message = transit_realtime.FeedMessage.decode(bytes);
  } catch {
    throw new Error('Malformed GTFS-Realtime feed');
  }

  const feed: NormalizedRealtimeFeed = {
    producerTimestampSeconds: ownNumber(message.header, 'timestamp'),
    tripUpdates: [],
    trips: [],
    vehicles: [],
    alerts: [],
    warnings: [],
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
    if (vehicle?.position?.latitude != null && vehicle.position.longitude != null) {
      feed.vehicles.push({
        entityId: entity.id,
        vehicleId: vehicle.vehicle?.id ?? undefined,
        label: vehicle.vehicle?.label ? sanitizeTransitText(vehicle.vehicle.label, 120) : undefined,
        tripId: vehicle.trip?.tripId ?? undefined,
        routeId: vehicle.trip?.routeId ?? undefined,
        latitude: vehicle.position.latitude,
        longitude: vehicle.position.longitude,
        bearing: vehicle.position.bearing ?? undefined,
        speedMetersPerSecond: vehicle.position.speed ?? undefined,
        timestampSeconds: ownNumber(vehicle, 'timestamp'),
      });
    }

    if (entity.alert) {
      const informedEntities = entity.alert.informedEntity ?? [];
      feed.alerts.push({
        id: entity.id,
        header: firstTranslation(entity.alert.headerText),
        description: firstTranslation(entity.alert.descriptionText),
        routeIds: [...new Set(informedEntities.flatMap(item => item.routeId ? [item.routeId] : []))],
        stopIds: [...new Set(informedEntities.flatMap(item => item.stopId ? [item.stopId] : []))],
      });
    }
  }

  if (message.entity.length === 0) feed.warnings.push('empty_feed');
  return feed;
}
