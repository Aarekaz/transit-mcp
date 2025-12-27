/**
 * Type Definitions
 * 
 * WHY CENTRALIZED TYPES:
 * - Single source of truth for data structures
 * - Easy to update across codebase
 * - Enables IDE autocomplete and type checking
 * - Self-documenting code through types
 */

/**
 * Cloudflare Workers Environment
 * 
 * WHY THIS INTERFACE:
 * Defines all environment variables and bindings available in Workers.
 * TypeScript uses this for type checking and autocomplete.
 * 
 * BINDINGS EXPLAINED:
 * - Environment variables: Configuration and secrets
 * - KV Namespaces: Key-value storage for OAuth clients and rate limiting
 * 
 * NOTE: Update this when adding new environment variables or KV namespaces
 */
export interface Env {
  // OAuth Configuration
  GITHUB_CLIENT_ID: string;        // GitHub OAuth App Client ID (public)
  GITHUB_CLIENT_SECRET: string;    // GitHub OAuth App Client Secret (secret)
  OAUTH_REDIRECT_URI: string;      // OAuth callback URL

  // API Keys
  WMATA_API_KEY: string;           // DC Metro (WMATA) API key (secret)

  // Security
  JWT_SECRET: string;              // Secret for signing JWT tokens (secret)

  // KV Namespace Bindings
  /**
   * OAuth client registration storage
   * 
   * WHY KV:
   * - Persistent storage for registered OAuth clients
   * - Low latency (edge caching)
   * - Simple key-value interface
   * 
   * USAGE:
   * await env.OAUTH_CLIENTS.put(clientId, JSON.stringify(clientData));
   * const client = await env.OAUTH_CLIENTS.get(clientId);
   */
  OAUTH_CLIENTS: KVNamespace;

  /**
   * Rate limiting storage
   * 
   * WHY SEPARATE KV:
   * - High write volume (every request)
   * - Automatic expiration (TTL)
   * - Separate from OAuth data (different access patterns)
   * 
   * USAGE:
   * await env.RATE_LIMIT_KV.put(key, count, { expirationTtl: 60 });
   * const count = await env.RATE_LIMIT_KV.get(key);
   */
  RATE_LIMIT_KV?: KVNamespace;     // Optional for backward compatibility

  // Optional Configuration
  ENVIRONMENT?: string;            // Environment name (development/staging/production)
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

/**
 * Authentication session data
 * 
 * WHY JWT SESSIONS:
 * - Stateless (no server-side session storage needed)
 * - Secure (signed with JWT_SECRET)
 * - Self-contained (includes all needed info)
 * 
 * STORED IN JWT TOKEN:
 * These fields are encoded in the JWT and sent to clients.
 * Don't include sensitive data that shouldn't be client-readable.
 */
export interface AuthSession {
  userId: string;        // GitHub user ID
  userLogin: string;     // GitHub username
  expiresAt: number;     // Unix timestamp (seconds)
}

/**
 * OAuth client registration data
 * 
 * WHY DYNAMIC CLIENT REGISTRATION:
 * Allows MCP clients to register themselves without manual setup.
 * Follows RFC 7591 for OAuth 2.0 Dynamic Client Registration.
 * 
 * STORED IN KV:
 * Persisted in OAUTH_CLIENTS namespace, keyed by client_id.
 */
export interface OAuthClient {
  client_id: string;              // Unique client identifier
  client_secret: string;          // Client secret (hashed)
  redirect_uris: string[];        // Allowed redirect URIs
  client_name?: string;           // Human-readable name
  created_at: number;             // Unix timestamp (milliseconds)
  last_used_at?: number;          // Unix timestamp (milliseconds)
}

/**
 * OAuth authorization state
 * 
 * WHY STATE PARAMETER:
 * - Prevents CSRF attacks on OAuth flow
 * - Links authorization request to callback
 * - Can store additional context
 * 
 * STORED IN KV:
 * Temporarily stored during OAuth flow, expires quickly.
 */
export interface OAuthState {
  state: string;                  // Random state parameter
  code_challenge: string;         // PKCE code challenge
  code_challenge_method: string;  // PKCE method (S256)
  client_id: string;              // OAuth client ID
  redirect_uri: string;           // Callback URI
  created_at: number;             // Unix timestamp (milliseconds)
}

/**
 * OAuth token response
 * 
 * WHY THESE FIELDS:
 * Standard OAuth 2.0 token response (RFC 6749)
 * 
 * SECURITY NOTE:
 * access_token is a JWT containing AuthSession data.
 * Never log or expose tokens in error messages.
 */
export interface OAuthTokenResponse {
  access_token: string;           // JWT access token
  token_type: 'Bearer';           // Always "Bearer" for JWT
  expires_in: number;             // Seconds until expiration
  scope?: string;                 // Granted scopes
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
