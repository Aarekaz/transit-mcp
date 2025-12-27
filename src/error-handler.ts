import { SupportedCity } from './transit/base';

/**
 * Generic transit error class
 */
export class TransitError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public city?: string,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'TransitError';
  }
}

/**
 * WMATA-specific error (extends TransitError)
 * Kept for backwards compatibility
 */
export class WMATAError extends TransitError {
  constructor(
    message: string,
    public override statusCode?: number,
    public override originalError?: unknown
  ) {
    super(message, statusCode, 'dc', originalError);
    this.name = 'WMATAError';
  }
}

/**
 * Handle transit errors with context
 */
export function handleWMATAError(error: unknown): string {
  if (error instanceof TransitError) {
    const cityContext = error.city ? ` [${error.city.toUpperCase()}]` : '';
    return `Transit API Error${cityContext} (${error.statusCode}): ${error.message}`;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return 'Unknown error occurred while accessing transit API';
}

/**
 * Validate city parameter
 */
export function validateCity(city: string): asserts city is SupportedCity {
  const supportedCities: SupportedCity[] = ['dc', 'nyc'];
  if (!supportedCities.includes(city as SupportedCity)) {
    throw new TransitError(`Unsupported city: ${city}. Supported: ${supportedCities.join(', ')}`);
  }
}

/**
 * Validate station ID based on city
 */
export function validateStationId(city: SupportedCity, stationId: string): string {
  const cleaned = stationId.trim().toUpperCase();

  if (city === 'dc') {
    // DC Metro: Letter + 2 digits (e.g., "A01", "C05")
    if (!cleaned || cleaned.length !== 3) {
      throw new TransitError('DC Metro station code must be exactly 3 characters (e.g., "A01", "C05")', undefined, city);
    }
    if (!/^[A-Z]\d{2}$/.test(cleaned)) {
      throw new TransitError('DC Metro station code must be: Letter followed by 2 digits (e.g., "A01")', undefined, city);
    }
  } else if (city === 'nyc') {
    // NYC Subway: Numeric with optional direction (e.g., "127", "127N", "127S")
    if (!/^\d{1,4}[NS]?$/i.test(cleaned)) {
      throw new TransitError('NYC Subway stop ID must be numeric (e.g., "127", "127N")', undefined, city);
    }
  }

  return cleaned;
}

/**
 * Validate line code based on city
 */
export function validateLineCode(city: SupportedCity, lineCode: string): string {
  const cleaned = lineCode.trim().toUpperCase();

  if (city === 'dc') {
    const validLines = ['RD', 'BL', 'YL', 'OR', 'GR', 'SV'];
    if (!validLines.includes(cleaned)) {
      throw new TransitError(`Invalid DC Metro line code. Must be one of: ${validLines.join(', ')}`, undefined, city);
    }
  } else if (city === 'nyc') {
    const validLines = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'N', 'Q', 'R', 'W', 'J', 'Z', 'L', 'G', 'SI', 'S'];
    if (!validLines.includes(cleaned)) {
      throw new TransitError(`Invalid NYC Subway line. Must be one of: ${validLines.join(', ')}`, undefined, city);
    }
  }

  return cleaned;
}

/**
 * Validate search query
 */
export function validateSearchQuery(query: string): string {
  if (!query || typeof query !== 'string') {
    throw new TransitError('Search query is required and must be a string');
  }

  const cleaned = query.trim();
  if (cleaned.length === 0) {
    throw new TransitError('Search query cannot be empty');
  }

  if (cleaned.length > 100) {
    throw new TransitError('Search query must be 100 characters or less');
  }

  // Basic XSS prevention
  if (/<[^>]*>/.test(cleaned)) {
    throw new TransitError('Search query contains invalid characters');
  }

  return cleaned;
}

/**
 * Validate tool parameters with city-awareness
 */
export function validateToolParameters(toolName: string, args: any): void {
  if (!args || typeof args !== 'object') {
    throw new TransitError('Tool arguments must be an object');
  }

  // Most tools now require city parameter
  const toolsRequiringCity = [
    'get_station_predictions',
    'search_stations',
    'get_stations_by_line',
    'get_incidents',
    'get_elevator_incidents',
    'get_all_stations'
  ];

  if (toolsRequiringCity.includes(toolName)) {
    if (!args.city) {
      throw new TransitError('city parameter is required');
    }
    validateCity(args.city);
  }

  // Tool-specific parameter validation
  switch (toolName) {
    case 'get_station_predictions':
      if (!args.stationName) {
        throw new TransitError('stationName parameter is required');
      }
      break;
    case 'search_stations':
      if (!args.query) {
        throw new TransitError('query parameter is required');
      }
      break;
    case 'get_stations_by_line':
      if (!args.lineCode) {
        throw new TransitError('lineCode parameter is required');
      }
      break;
    case 'get_bus_predictions':
      if (!args.stopId) {
        throw new TransitError('stopId parameter is required');
      }
      // Validate stop ID format (7 digits)
      if (!/^\d{7}$/.test(args.stopId)) {
        throw new TransitError('stopId must be a 7-digit number');
      }
      break;
    case 'get_train_positions':
      // No parameters required for this tool
      break;

    case 'get_bus_routes':
      // No parameters required for this tool
      break;

    case 'get_bus_stops': {
      const { latitude, longitude, radius } = args;

      // If any coordinate is provided, both must be provided
      if ((latitude !== undefined || longitude !== undefined) &&
          !(latitude !== undefined && longitude !== undefined)) {
        throw new TransitError('Both latitude and longitude must be provided together for location search');
      }

      // Validate coordinate ranges
      if (latitude !== undefined) {
        if (typeof latitude !== 'number') {
          throw new TransitError('latitude must be a number');
        }
        if (latitude < -90 || latitude > 90) {
          throw new TransitError('latitude must be between -90 and 90');
        }
      }

      if (longitude !== undefined) {
        if (typeof longitude !== 'number') {
          throw new TransitError('longitude must be a number');
        }
        if (longitude < -180 || longitude > 180) {
          throw new TransitError('longitude must be between -180 and 180');
        }
      }

      // Validate radius
      if (radius !== undefined) {
        if (typeof radius !== 'number') {
          throw new TransitError('radius must be a number');
        }
        if (radius <= 0) {
          throw new TransitError('radius must be a positive number (in meters)');
        }
      }

      break;
    }

    case 'get_bus_positions': {
      const { routeId } = args;

      // routeId is optional, but if provided should be validated
      if (routeId !== undefined) {
        if (typeof routeId !== 'string') {
          throw new TransitError('routeId must be a string');
        }
        if (routeId.trim().length === 0) {
          throw new TransitError('routeId cannot be empty');
        }
      }

      break;
    }
  }
}

// Legacy exports for backwards compatibility
export function validateStationCode(code: string): string {
  return validateStationId('dc', code);
}