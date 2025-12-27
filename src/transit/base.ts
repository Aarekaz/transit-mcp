/**
 * Transit API Abstraction Layer
 *
 * Common interfaces and base class for all transit system clients.
 * Enables unified handling of DC Metro (WMATA), NYC Subway (MTA), and future systems.
 */

export type SupportedCity = 'dc' | 'nyc';

/**
 * Transfer connection to another station
 */
export interface StationTransfer {
  /** Target station ID */
  toStationId: string;

  /** Target station name */
  toStationName: string;

  /** Walk time in seconds (0 = same station platform switch) */
  transferTime: number;

  /** Transfer type: 'platform' (same station) or 'nearby' (different station) */
  transferType: 'platform' | 'nearby';
}

/**
 * Normalized station representation across all transit systems
 */
export interface TransitStation {
  /** Normalized station ID (e.g., "A01" for DC, "127" for NYC) */
  id: string;

  /** Station name (e.g., "Metro Center", "Times Square") */
  name: string;

  /** City identifier */
  city: SupportedCity;

  /** Latitude coordinate */
  latitude: number;

  /** Longitude coordinate */
  longitude: number;

  /** Line codes/numbers serving this station (e.g., ["RD", "OR"] or ["1", "2", "3"]) */
  lines: string[];

  /** Optional: Full address */
  address?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };

  /** Optional: Parent station ID (for child platforms like "127N" -> "127") */
  parentStation?: string;

  /** Optional: Child platform IDs (for parent stations: "127" -> ["127N", "127S"]) */
  childPlatforms?: string[];

  /** Optional: Transfer connections to other stations */
  transfers?: StationTransfer[];
}

/**
 * Normalized train prediction across all transit systems
 */
export interface TransitPrediction {
  /** City identifier */
  city: SupportedCity;

  /** Line identifier (e.g., "RD", "1", "A") */
  line: string;

  /** Destination station name */
  destination: string;

  /** Destination station code (if available) */
  destinationCode?: string;

  /** Arrival time - ISO format or special values like "ARR", "BRD" */
  arrivalTime: string;

  /** Minutes until arrival - number or special strings like "ARR", "BRD" */
  minutesAway: number | string;

  /** Optional: Number of cars */
  cars?: string;

  /** Optional: Track/platform information */
  track?: string;

  /** Optional: Direction (e.g., "NORTH", "SOUTH") */
  direction?: string;
}

/**
 * Normalized incident/service alert across all transit systems
 */
export interface TransitIncident {
  /** City identifier */
  city: SupportedCity;

  /** Unique incident identifier */
  incidentId: string;

  /** Human-readable description */
  description: string;

  /** Lines affected by this incident */
  linesAffected: string[];

  /** Severity level (e.g., "Major", "Minor", "Medium") */
  severity: string;

  /** Incident type (e.g., "Delay", "Alert") */
  incidentType: string;

  /** When the incident was last updated (ISO timestamp) */
  timestamp: string;

  /** Optional: Passenger delay in minutes */
  passengerDelay?: number;

  /** Optional: Start location */
  startLocation?: string;

  /** Optional: End location */
  endLocation?: string;
}

/**
 * Transit route information (e.g., A train, Red Line)
 */
export interface TransitRoute {
  /** Route ID (e.g., "A", "1", "RD") */
  routeId: string;

  /** Short name displayed on trains (e.g., "A", "1", "Red") */
  shortName: string;

  /** Long descriptive name (e.g., "8 Avenue Express", "Red Line") */
  longName: string;

  /** Detailed service description (schedule patterns, service areas) */
  description: string;

  /** City this route serves */
  city: SupportedCity;
}

/**
 * Abstract base class for all transit API clients
 *
 * Each transit system (WMATA, MTA, etc.) extends this class and implements
 * the abstract methods to provide normalized data.
 */
export abstract class TransitAPIClient {
  protected apiKey?: string;
  protected city: SupportedCity;

  constructor(city: SupportedCity, apiKey?: string) {
    this.city = city;
    this.apiKey = apiKey;
  }

  /**
   * Fetch all stations in the transit system
   */
  abstract getStations(): Promise<TransitStation[]>;

  /**
   * Get real-time predictions for a specific station
   * @param stationId - Normalized station ID
   */
  abstract getStationPredictions(stationId: string): Promise<TransitPrediction[]>;

  /**
   * Get current incidents/service alerts
   */
  abstract getIncidents(): Promise<TransitIncident[]>;

  /**
   * Search for stations by name or code
   * @param query - Search query (station name or code)
   */
  abstract searchStation(query: string): Promise<TransitStation[]>;

  /**
   * Get stations on a specific line
   * @param lineCode - Line identifier (e.g., "RD", "1", "A")
   */
  abstract getStationsByLine(lineCode: string): Promise<TransitStation[]>;

  /**
   * Get detailed route information
   * @param routeId - Route identifier (e.g., "A", "1", "RD")
   */
  abstract getRouteInfo(routeId: string): Promise<TransitRoute | null>;

  /**
   * Get the city this client serves
   */
  getCity(): SupportedCity {
    return this.city;
  }
}
