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
  vehicles: NormalizedVehicle[];
  alerts: NormalizedAlert[];
  warnings: string[];
}

function numberValue(value: number | { toString(): string } | null | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : undefined;
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
    producerTimestampSeconds: numberValue(message.header.timestamp),
    tripUpdates: [],
    vehicles: [],
    alerts: [],
    warnings: [],
  };

  for (const entity of message.entity) {
    for (const update of entity.tripUpdate?.stopTimeUpdate ?? []) {
      if (!update.stopId) continue;
      feed.tripUpdates.push({
        entityId: entity.id,
        tripId: entity.tripUpdate?.trip?.tripId ?? undefined,
        routeId: entity.tripUpdate?.trip?.routeId ?? undefined,
        stopId: update.stopId,
        stopSequence: update.stopSequence ?? undefined,
        arrivalTimeSeconds: numberValue(update.arrival?.time),
        departureTimeSeconds: numberValue(update.departure?.time),
      });
    }

    const vehicle = entity.vehicle;
    if (vehicle?.position?.latitude != null && vehicle.position.longitude != null) {
      feed.vehicles.push({
        entityId: entity.id,
        vehicleId: vehicle.vehicle?.id ?? undefined,
        label: vehicle.vehicle?.label ?? undefined,
        tripId: vehicle.trip?.tripId ?? undefined,
        routeId: vehicle.trip?.routeId ?? undefined,
        latitude: vehicle.position.latitude,
        longitude: vehicle.position.longitude,
        bearing: vehicle.position.bearing ?? undefined,
        speedMetersPerSecond: vehicle.position.speed ?? undefined,
        timestampSeconds: numberValue(vehicle.timestamp),
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
