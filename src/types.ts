/**
 * Type Definitions
 * 
 * WHY CENTRALIZED TYPES:
 * - Single source of truth for data structures
 * - Easy to update across codebase
 * - Enables IDE autocomplete and type checking
 * - Self-documenting code through types
 */

import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/**
 * Cloudflare Workers Environment
 * 
 * WHY THIS INTERFACE:
 * Defines all environment variables and bindings available in Workers.
 * TypeScript uses this for type checking and autocomplete.
 * 
 * BINDINGS EXPLAINED:
 * - Environment variables: Configuration and secrets
 * - KV Namespaces: Provider-owned OAuth protocol storage
 * 
 * NOTE: Update this when adding new environment variables or KV namespaces
 */
export interface Env {
  // Canonical MCP deployment configuration
  MCP_PUBLIC_ORIGIN: string;
  MCP_ALLOWED_HOSTNAMES: string;
  MCP_ALLOWED_ORIGIN_HOSTNAMES: string;
  MCP_REQUEST_STATE_KEY: string;

  // OAuth Configuration
  GITHUB_CLIENT_ID: string;        // GitHub OAuth App Client ID (public)
  GITHUB_CLIENT_SECRET: string;    // GitHub OAuth App Client Secret (secret)
  OAUTH_REDIRECT_URI: string;      // OAuth callback URL

  // API Keys
  WMATA_API_KEY: string;           // DC Metro (WMATA) API key (secret)

  // Security
  JWT_SECRET: string;              // Secret for signing JWT tokens (secret)

  /** OAuth Provider protocol storage. */
  OAUTH_KV: KVNamespace;

  /** OAuth Provider helpers injected into protected/default handlers. */
  OAUTH_PROVIDER: OAuthHelpers;

  /**
   * MCP session storage (legacy KV path).
   *
   * Sessions now live in the MetroMcpAgent Durable Object via the
   * MCP_SESSION binding below. This KV binding is kept as optional so
   * any existing values can drain (24h TTL) without a deploy-time
   * binding error. Remove from wrangler.jsonc and this interface in a
   * follow-up once observation confirms no live sessions remain.
   */
  MCP_SESSIONS?: KVNamespace;

  /**
   * Inactive MCP session namespace retained only so the rollback class
   * continues to type-check until Task 12 removes the active binding.
   */
  MCP_SESSION?: DurableObjectNamespace;

  /**
   * Static assets fetcher (public/index.html landing page).
   * The worker delegates unmatched GETs here so the landing page renders
   * instead of 404ing.
   */
  ASSETS: Fetcher;

  // Deployment environment
  ENVIRONMENT: 'development' | 'preview' | 'production';
}

/**
 * User information from OAuth provider
 * 
 * WHY THESE FIELDS:
 * - id: Unique identifier for the user
 * - login: Username (for display and logging)
 * - name: Display name
 * - email: Contact information (may be empty if private)
 * - avatar_url: Profile picture
 */
export interface User {
  id: string;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}

/** Application-owned state between Provider validation and GitHub identity. */
export interface PendingGitHubLogin {
  authRequest: AuthRequest;
  clientName: string;
  createdAt: number;
}

/** Application-owned state between GitHub identity and explicit MCP consent. */
export interface PendingConsent extends PendingGitHubLogin {
  user: {
    id: string;
    login: string;
  };
}

/**
 * Transit station information
 * 
 * WHY NORMALIZED TYPE:
 * Different transit APIs (WMATA, MTA) return different formats.
 * This normalized type makes it easy to work with any city's data.
 */
export interface TransitStation {
  id: string;                     // Station code/ID
  name: string;                   // Station name
  lines: string[];                // Lines serving this station
  latitude: number;               // Coordinates
  longitude: number;
  address?: string;               // Physical address
}

/**
 * Transit prediction (real-time arrival)
 * 
 * WHY NORMALIZED TYPE:
 * Makes it easy to display predictions from any transit system
 * in a consistent format.
 */
export interface TransitPrediction {
  line: string;                   // Line name/code
  destination: string;            // Final destination
  minutesAway: number | string;   // Minutes until arrival (or "ARR", "BRD")
  cars?: number;                  // Number of cars
  direction?: string;             // Direction of travel
  track?: string;                 // Track/platform number
}

/**
 * Transit service incident/alert
 * 
 * WHY NORMALIZED TYPE:
 * Consistent incident reporting across all transit systems.
 */
export interface TransitIncident {
  incidentId: string;             // Unique incident ID
  description: string;            // Human-readable description
  linesAffected: string[];        // Affected lines
  severity?: string;              // Severity level
  incidentType: string;           // Type of incident
  timestamp: string;              // ISO 8601 timestamp
  startLocation?: string;         // Start location
  endLocation?: string;           // End location
}

/**
 * WMATA API Response Types
 *
 * WHY WMATA-SPECIFIC TYPES:
 * WMATA (DC Metro) API returns data in a specific format.
 * These types match the actual API responses from api.wmata.com.
 * The WMATAClient normalizes these to the common Transit types above.
 */

/**
 * WMATA station address
 */
export interface WMATAAddress {
  City: string;
  State: string;
  Street: string;
  Zip: string;
}

/**
 * WMATA station data from API
 */
export interface WMATAStation {
  Address: WMATAAddress;
  Code: string;
  Lat: number;
  Lon: number;
  LineCode1: string;
  LineCode2: string | null;
  LineCode3: string | null;
  LineCode4: string | null;
  Name: string;
  StationTogether1: string;
  StationTogether2: string;
}

/**
 * WMATA train prediction from API
 */
export interface WMATAPrediction {
  Car: string;
  Destination: string;
  DestinationCode: string;
  DestinationName: string;
  Group: string;
  Line: string;
  LocationCode: string;
  LocationName: string;
  Min: string;
}

/**
 * WMATA incident/alert from API
 */
export interface WMATAIncident {
  DateUpdated: string;
  DelaySeverity: string | null;
  Description: string;
  EmergencyText: string | null;
  EndLocationFullName: string | null;
  IncidentID: string;
  IncidentType: string;
  LinesAffected: string;
  PassengerDelay: number;
  StartLocationFullName: string | null;
}

/**
 * WMATA elevator/escalator outage from API
 *
 * Endpoint: /Incidents.svc/json/ElevatorIncidents
 */
export interface WMATAElevatorIncident {
  UnitName: string;
  UnitType: string;
  UnitStatus: string | null;
  StationCode: string;
  StationName: string;
  LocationDescription: string;
  SymptomCode: string | null;
  SymptomDescription: string;
  TimeOutOfService: string;
  DisplayOrder: number;
  DateOutOfServ: string;
  DateUpdated: string;
  EstimatedReturnToService: string | null;
}

/**
 * WMATA bus prediction from API
 *
 * Endpoint: /NextBusService.svc/json/jPredictions
 * Returns next bus arrival times at a stop
 */
export interface WMATABusPrediction {
  DirectionNum: string;
  DirectionText: string;
  Minutes: number;
  RouteID: string;
  TripID: string;
  VehicleID: string;
}

/**
 * WMATA train position from API
 *
 * Endpoint: /TrainPositions/TrainPositions
 * Returns real-time train positions and track circuit occupancy
 * Refreshed every 7-10 seconds
 */
export interface WMATATrainPosition {
  TrainId: string;
  TrainNumber: string;
  CarCount: number;
  DirectionNum: number;
  CircuitId: number;
  DestinationStationCode: string | null;
  LineCode: string | null;
  SecondsAtLocation: number;
  ServiceType: string;
}

/**
 * WMATA bus route from API
 *
 * Endpoint: /Bus.svc/json/jRoutes
 * Returns list of all bus route variants
 */
export interface WMATABusRoute {
  RouteID: string;
  Name: string;
  LineDescription: string;
}

/**
 * WMATA bus stop from API
 *
 * Endpoint: /Bus.svc/json/jStops
 * Returns bus stops by location or all stops
 */
export interface WMATABusStop {
  Lat: number;
  Lon: number;
  Name: string;
  Routes: string[];
  StopID: string;
}

/**
 * WMATA bus position from API
 *
 * Endpoint: /Bus.svc/json/jBusPositions
 * Returns real-time bus positions
 * Refreshed every 7-10 seconds
 */
export interface WMATABusPosition {
  DateTime: string;
  Deviation: number;
  DirectionNum: string;
  DirectionText: string;
  Lat: number;
  Lon: number;
  RouteID: string;
  TripEndTime: string;
  TripHeadsign: string;
  TripID: string;
  TripStartTime: string;
  VehicleID: string;
}

/**
 * Request validation result
 *
 * WHY RESULT TYPE:
 * Allows functions to return success/failure without throwing.
 * Makes error handling more explicit.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitizedValue?: any;
}

/**
 * Rate limit tracking data
 * 
 * WHY SEPARATE TYPE:
 * Documents what data is stored in rate limit KV entries.
 */
export interface RateLimitData {
  count: number;                  // Number of requests in window
  windowStart: number;            // Unix timestamp (milliseconds)
  clientId: string;               // Client identifier (IP)
}
