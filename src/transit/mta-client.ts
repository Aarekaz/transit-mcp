/**
 * MTA (NYC Subway) API Client
 *
 * Implements GTFS-realtime parsing for New York City subway system.
 * Uses Protocol Buffers to parse real-time train predictions from route feeds.
 */

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import {
  TransitAPIClient,
  TransitStation,
  TransitPrediction,
  TransitIncident,
  TransitRoute,
  StationTransfer,
} from './base';
import { NYC_STATIONS } from './nyc-stations';
import { NYC_ROUTES } from './nyc-routes';

/**
 * MTA GTFS-Realtime feed URLs
 * Each feed serves specific subway lines
 */
const MTA_FEEDS = {
  'ACE': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'BDFM': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'G': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  'JZ': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  'NQRW': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  'L': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  '1234567': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'SIR': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si',
} as const;

function eventTimestamp(event: GtfsRealtimeBindings.transit_realtime.TripUpdate.IStopTimeEvent | null | undefined): number | undefined {
  // protobufjs exposes an inherited zero even when the optional field is absent.
  if (!event || !Object.prototype.hasOwnProperty.call(event, 'time')) return undefined;
  const seconds = Number(event.time);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

interface CachedFeed {
  data: GtfsRealtimeBindings.transit_realtime.FeedMessage;
  timestamp: number;
}

export class MTAClient extends TransitAPIClient {
  private feedCache: Map<keyof typeof MTA_FEEDS, CachedFeed>;
  private cacheTTL: number;

  constructor() {
    super('nyc'); // No API key needed for MTA public feeds
    this.feedCache = new Map();
    this.cacheTTL = 30000; // 30 seconds per GTFS-realtime spec
  }

  /**
   * Fetch and parse a GTFS-realtime feed
   */
  private async fetchFeed(
    feedKey: keyof typeof MTA_FEEDS,
    signal?: AbortSignal
  ): Promise<GtfsRealtimeBindings.transit_realtime.FeedMessage> {
    // Check cache
    const cached = this.feedCache.get(feedKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }

    // Fetch fresh data
    const feedUrl = MTA_FEEDS[feedKey];
    const response = await fetch(feedUrl, { signal });

    if (!response.ok) {
      throw new Error('MTA feed unavailable');
    }

    // Parse protobuf
    const buffer = await response.arrayBuffer();
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    // Cache the parsed feed
    this.feedCache.set(feedKey, {
      data: feed,
      timestamp: Date.now(),
    });

    return feed;
  }

  /**
   * Get all stations in NYC subway system
   */
  async getStations(_signal?: AbortSignal): Promise<TransitStation[]> {
    // In production, this would load from GTFS static data
    // For now, returning the sample stations
    return NYC_STATIONS;
  }

  /**
   * Get real-time train predictions for a station
   */
  async getStationPredictions(
    stationId: string,
    signal?: AbortSignal
  ): Promise<TransitPrediction[]> {
    const predictions: TransitPrediction[] = [];

    // A realtime reroute can serve a platform outside its static route membership.
    // No current authoritative evidence rules any feed out for this station.
    // The route IDs (including GS, FS and H shuttles) come from each trip update.
    const feedsToCheck = Object.keys(MTA_FEEDS) as (keyof typeof MTA_FEEDS)[];
    const now = Date.now();

    for (const feedKey of feedsToCheck) {
      signal?.throwIfAborted();
      try {
        const feed = await this.fetchFeed(feedKey, signal);

        for (const entity of feed.entity) {
          if (!entity.tripUpdate || entity.isDeleted) continue;

          const tripUpdate = entity.tripUpdate;
          const trip = tripUpdate.trip;

          if (!trip || !tripUpdate.stopTimeUpdate || trip.scheduleRelationship === 3) continue;

          // NYCT documents that updates contain ALL remaining stops. The last
          // stop therefore identifies this trip's destination, including short
          // turns; do not substitute the current platform or a route terminus.
          const terminalId = tripUpdate.stopTimeUpdate.at(-1)?.stopId?.replace(/[NS]$/, '');
          const terminal = NYC_STATIONS.find(candidate => candidate.id === terminalId);

          // Find stop time updates for this station
          for (const stopTimeUpdate of tripUpdate.stopTimeUpdate) {
            // Match station ID (handling directional suffixes like "127N", "127S")
            const stopId = stopTimeUpdate.stopId || '';
            const baseStopId = stopId.replace(/[NS]$/, '');

            if (baseStopId === stationId || stopId === stationId) {
              if (stopTimeUpdate.scheduleRelationship === 1 || stopTimeUpdate.scheduleRelationship === 2) continue;
              const arrivalSeconds = eventTimestamp(stopTimeUpdate.arrival);
              const departureSeconds = eventTimestamp(stopTimeUpdate.departure);
              const eventSeconds = arrivalSeconds ?? departureSeconds;
              if (eventSeconds === undefined) continue;
              const lastEventSeconds = departureSeconds ?? arrivalSeconds!;
              // NYCT removes a stop only after departure. A retained past-due
              // estimate is uncertain/delayed, not proof that the train has left.
              const delayed = lastEventSeconds * 1000 < now;

              // Calculate minutes away
              const arrivalDate = new Date(eventSeconds * 1000);
              const minutesAway = Math.floor((arrivalDate.getTime() - now) / 60000);
              const boarding = arrivalSeconds !== undefined && arrivalSeconds * 1000 <= now
                && departureSeconds !== undefined && departureSeconds * 1000 >= now;

              // Determine direction from stop_id suffix
              const direction = stopId.endsWith('N') ? 'NORTH' : stopId.endsWith('S') ? 'SOUTH' : undefined;

              predictions.push({
                city: 'nyc',
                line: trip.routeId || '',
                destination: terminal?.name ?? 'Unknown',
                destinationCode: terminal?.id,
                arrivalTime: arrivalDate.toISOString(),
                minutesAway: delayed ? 0 : boarding ? 'BRD' : minutesAway <= 0 ? 'ARR' : minutesAway,
                arrivalStatus: delayed ? 'DELAYED' : undefined,
                direction,
              });
            }
          }
        }
      } catch (error) {
        if (
          signal?.aborted ||
          (typeof error === 'object' &&
            error !== null &&
            'name' in error &&
            error.name === 'AbortError')
        ) {
          throw error;
        }
        // The legacy schema has no completeness field. A required-feed failure
        // must be an error, never a plausible complete (or quiet) station board.
        throw new Error('MTA predictions unavailable: a required feed could not be loaded');
      }
    }

    // Sort by arrival time
    predictions.sort((a, b) => Date.parse(a.arrivalTime) - Date.parse(b.arrivalTime));

    return predictions;
  }

  /**
   * Get current service alerts and incidents
   * Uses dedicated subway-alerts feed for better performance (1 call vs 8)
   */
  async getIncidents(signal?: AbortSignal): Promise<TransitIncident[]> {
    const incidents: TransitIncident[] = [];

    try {
      // Fetch from dedicated alerts feed (JSON format, faster than protobuf)
      const response = await fetch(
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json',
        { signal }
      );

      if (!response.ok) {
        throw new Error(`MTA alerts fetch failed: ${response.status}`);
      }

      const data = await response.json() as any;

      for (const entity of data.entity || []) {
        if (!entity.alert) continue;

        const alert = entity.alert;

        // Extract affected lines from informed_entity
        const linesAffected: string[] = [];
        if (alert.informed_entity) {
          for (const informed of alert.informed_entity) {
            if (informed.route_id) {
              linesAffected.push(informed.route_id);
            }
          }
        }

        // Get plain text description (prefer over HTML)
        const description =
          alert.header_text?.translation?.find((t: any) => t.language === 'en')?.text ||
          alert.header_text?.translation?.[0]?.text ||
          'Service alert';

        // Get alert type from mercury extensions
        const alertType = alert['transit_realtime.mercury_alert']?.alert_type || 'Alert';

        // Get timestamp from mercury extensions
        const updatedAt = alert['transit_realtime.mercury_alert']?.updated_at;
        const updatedDate = typeof updatedAt === 'number' && updatedAt > 0
          ? new Date(updatedAt * 1000) : undefined;
        const timestamp = updatedDate && Number.isFinite(updatedDate.getTime())
          ? updatedDate.toISOString()
          : 'Unknown';

        incidents.push({
          city: 'nyc',
          incidentId: entity.id,
          description,
          linesAffected: [...new Set(linesAffected)], // Remove duplicates
          severity: alertType, // Use alert_type as severity (Delays, Service Change, etc.)
          incidentType: alertType,
          timestamp,
        });
      }
    } catch (error) {
      if (
        signal?.aborted ||
        (typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          error.name === 'AbortError')
      ) {
        throw error;
      }
      throw new Error('MTA service alerts unavailable');
    }

    return incidents;
  }

  /**
   * Search for stations by name or code
   * Handles common abbreviations (Square→Sq, Street→St, etc.)
   */
  async searchStation(
    query: string,
    _signal?: AbortSignal
  ): Promise<TransitStation[]> {
    const normalizedQuery = query.toLowerCase().trim();

    // Common abbreviation mappings for fuzzy matching
    const fuzzyQuery = normalizedQuery
      .replace(/\bsquare\b/g, 'sq')
      .replace(/\bstreet\b/g, 'st')
      .replace(/\bavenue\b/g, 'av')
      .replace(/\bboulevard\b/g, 'blvd')
      .replace(/\broad\b/g, 'rd');

    return NYC_STATIONS.filter(
      (station) => {
        const stationName = station.name.toLowerCase();
        return (
          stationName.includes(normalizedQuery) ||
          stationName.includes(fuzzyQuery) ||
          station.id.toLowerCase() === normalizedQuery
        );
      }
    );
  }

  /**
   * Get stations on a specific line
   */
  async getStationsByLine(
    lineCode: string,
    _signal?: AbortSignal
  ): Promise<TransitStation[]> {
    return NYC_STATIONS.filter((station) => station.lines.includes(lineCode.toUpperCase()));
  }

  /**
   * Get detailed route information
   */
  async getRouteInfo(routeId: string, _signal?: AbortSignal): Promise<TransitRoute | null> {
    const route = NYC_ROUTES.find((r) => r.routeId === routeId.toUpperCase());
    return route || null;
  }

  /**
   * Get transfer connections from a station
   */
  async getStationTransfers(
    stationId: string,
    _signal?: AbortSignal
  ): Promise<StationTransfer[]> {
    const station = NYC_STATIONS.find((s) => s.id === stationId);
    return station?.transfers || [];
  }
}
