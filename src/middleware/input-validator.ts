/**
 * Input Validation and Sanitization
 * 
 * SECURITY PHILOSOPHY:
 * "Never trust user input" - This module implements defense in depth
 * by validating and sanitizing all user inputs before processing.
 * 
 * WHY SEPARATE MODULE:
 * - Centralized validation logic (easier to audit and update)
 * - Reusable across different handlers
 * - Easy to test in isolation
 * - Clear separation of concerns
 * 
 * VALIDATION STRATEGY:
 * 1. Type checking (is it a string, number, etc.?)
 * 2. Format validation (does it match expected patterns?)
 * 3. Range checking (is it within acceptable bounds?)
 * 4. Sanitization (remove/escape dangerous characters)
 * 5. Whitelist approach (only allow known-good values)
 */

/**
 * Validation error with details for debugging
 * 
 * WHY DETAILED ERRORS:
 * Help developers understand what went wrong and how to fix it
 * (but don't expose internal system details that could aid attackers)
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public field: string,
    public value: any,
    public constraint: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validation rules for different input types
 * 
 * WHY THESE SPECIFIC RULES:
 * Each rule is based on actual API requirements and security best practices
 */
export const ValidationRules = {
  /** 
   * Station name validation
   * WHY: Station names should be alphanumeric with common punctuation
   * EXAMPLES: "Union Station", "L'Enfant Plaza", "42nd St-Times Square"
   */
  stationName: {
    minLength: 1,
    maxLength: 100,
    pattern: /^[a-zA-Z0-9\s\-'.()&\/]+$/,
    description: 'Letters, numbers, spaces, hyphens, periods, apostrophes, parentheses, ampersands, and forward slashes only'
  },

  /**
   * Station code validation
   * WHY: Different transit systems use different formats
   * DC: A01, B02, etc. (letter + 2 digits)
   * NYC: 123, 456N, etc. (numbers with optional N/S)
   */
  stationCode: {
    minLength: 1,
    maxLength: 10,
    pattern: /^[A-Z0-9]+[NS]?$/,
    description: 'Uppercase letters and numbers, optionally ending with N or S'
  },

  /**
   * Line code validation
   * WHY: Transit lines use short codes
   * DC: RD, BL, OR, SV, GR, YL
   * NYC: 1, 2, 3, A, C, E, etc.
   */
  lineCode: {
    minLength: 1,
    maxLength: 10,
    pattern: /^[A-Z0-9\-\/]+$/,
    description: 'Uppercase letters, numbers, hyphens, and forward slashes only'
  },

  /**
   * Search query validation
   * WHY: Allow natural language but prevent injection attacks
   * More permissive than station names to support fuzzy search
   */
  searchQuery: {
    minLength: 1,
    maxLength: 100,
    pattern: /^[a-zA-Z0-9\s\-'.()&\/,]+$/,
    description: 'Letters, numbers, spaces, and common punctuation only'
  },

  /**
   * City code validation
   * WHY: Strict whitelist of supported cities
   * SECURITY: Prevents path traversal attacks if used in file paths
   */
  cityCode: {
    allowedValues: ['dc', 'nyc'],
    pattern: /^[a-z]+$/,
    description: 'Must be one of: dc, nyc'
  }
} as const;

/**
 * Sanitize a string by removing/escaping dangerous characters
 * 
 * WHY NEEDED:
 * Even with validation, we sanitize as defense in depth
 * Removes characters that could be used for:
 * - XSS attacks (script injection)
 * - SQL injection (though we don't use SQL)
 * - Command injection
 * - Path traversal
 * 
 * WHAT IT DOES:
 * 1. Trims whitespace (prevents invisible characters)
 * 2. Removes null bytes (prevents string termination attacks)
 * 3. Removes control characters (prevents terminal manipulation)
 * 4. Normalizes Unicode (prevents homograph attacks)
 * 
 * @param input - String to sanitize
 * @param maxLength - Maximum allowed length (prevents DoS via huge strings)
 * @returns Sanitized string
 */
export function sanitizeString(input: string, maxLength: number = 1000): string {
  if (typeof input !== 'string') {
    throw new ValidationError(
      'Input must be a string',
      'input',
      input,
      'type must be string'
    );
  }

  // Trim whitespace
  let sanitized = input.trim();

  // Remove null bytes (can cause string termination issues)
  sanitized = sanitized.replace(/\0/g, '');

  // Remove control characters (except newlines and tabs, which are safe)
  // WHY: Control characters can manipulate terminal output or bypass filters
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Normalize Unicode to prevent homograph attacks
  // WHY: "а" (Cyrillic) looks like "a" (Latin) but is different
  // NFD = Canonical Decomposition
  sanitized = sanitized.normalize('NFD');

  // Enforce maximum length (prevents DoS)
  if (sanitized.length > maxLength) {
    throw new ValidationError(
      `Input exceeds maximum length of ${maxLength} characters`,
      'input',
      input,
      `maxLength: ${maxLength}`
    );
  }

  return sanitized;
}

/**
 * Validate and sanitize a station name
 * 
 * USAGE:
 * ```typescript
 * const stationName = validateStationName(userInput);
 * // Now safe to use in API calls
 * ```
 */
export function validateStationName(input: unknown): string {
  if (typeof input !== 'string') {
    throw new ValidationError(
      'Station name must be a string',
      'stationName',
      input,
      'type must be string'
    );
  }

  const sanitized = sanitizeString(input, ValidationRules.stationName.maxLength);

  if (sanitized.length < ValidationRules.stationName.minLength) {
    throw new ValidationError(
      `Station name must be at least ${ValidationRules.stationName.minLength} character(s)`,
      'stationName',
      input,
      `minLength: ${ValidationRules.stationName.minLength}`
    );
  }

  if (!ValidationRules.stationName.pattern.test(sanitized)) {
    throw new ValidationError(
      `Invalid station name format. ${ValidationRules.stationName.description}`,
      'stationName',
      input,
      ValidationRules.stationName.description
    );
  }

  return sanitized;
}

/**
 * Validate and sanitize a station code
 * 
 * SPECIAL HANDLING:
 * Converts to uppercase for consistency
 * (Most transit APIs expect uppercase codes)
 */
export function validateStationCode(input: unknown): string {
  if (typeof input !== 'string') {
    throw new ValidationError(
      'Station code must be a string',
      'stationCode',
      input,
      'type must be string'
    );
  }

  const sanitized = sanitizeString(input, ValidationRules.stationCode.maxLength).toUpperCase();

  if (sanitized.length < ValidationRules.stationCode.minLength) {
    throw new ValidationError(
      `Station code must be at least ${ValidationRules.stationCode.minLength} character(s)`,
      'stationCode',
      input,
      `minLength: ${ValidationRules.stationCode.minLength}`
    );
  }

  if (!ValidationRules.stationCode.pattern.test(sanitized)) {
    throw new ValidationError(
      `Invalid station code format. ${ValidationRules.stationCode.description}`,
      'stationCode',
      input,
      ValidationRules.stationCode.description
    );
  }

  return sanitized;
}

/**
 * Validate and sanitize a line code
 * 
 * EXAMPLES: "RD", "BL", "1", "A/C", "4-5-6"
 */
export function validateLineCode(input: unknown): string {
  if (typeof input !== 'string') {
    throw new ValidationError(
      'Line code must be a string',
      'lineCode',
      input,
      'type must be string'
    );
  }

  const sanitized = sanitizeString(input, ValidationRules.lineCode.maxLength).toUpperCase();

  if (sanitized.length < ValidationRules.lineCode.minLength) {
    throw new ValidationError(
      `Line code must be at least ${ValidationRules.lineCode.minLength} character(s)`,
      'lineCode',
      input,
      `minLength: ${ValidationRules.lineCode.minLength}`
    );
  }

  if (!ValidationRules.lineCode.pattern.test(sanitized)) {
    throw new ValidationError(
      `Invalid line code format. ${ValidationRules.lineCode.description}`,
      'lineCode',
      input,
      ValidationRules.lineCode.description
    );
  }

  return sanitized;
}

/**
 * Validate and sanitize a search query
 * 
 * WHY MORE PERMISSIVE:
 * Search queries can be more free-form ("42nd street times square")
 * but still need protection against injection attacks
 */
export function validateSearchQuery(input: unknown): string {
  if (typeof input !== 'string') {
    throw new ValidationError(
      'Search query must be a string',
      'query',
      input,
      'type must be string'
    );
  }

  const sanitized = sanitizeString(input, ValidationRules.searchQuery.maxLength);

  if (sanitized.length < ValidationRules.searchQuery.minLength) {
    throw new ValidationError(
      `Search query must be at least ${ValidationRules.searchQuery.minLength} character(s)`,
      'query',
      input,
      `minLength: ${ValidationRules.searchQuery.minLength}`
    );
  }

  if (!ValidationRules.searchQuery.pattern.test(sanitized)) {
    throw new ValidationError(
      `Invalid search query format. ${ValidationRules.searchQuery.description}`,
      'query',
      input,
      ValidationRules.searchQuery.description
    );
  }

  return sanitized;
}

/**
 * Validate a city code
 * 
 * WHY WHITELIST:
 * Only allow explicitly supported cities
 * Prevents attacks via unexpected values
 * 
 * SECURITY NOTE:
 * If city codes were ever used in file paths or commands,
 * this whitelist would prevent directory traversal attacks
 */
export function validateCityCode(input: unknown): 'dc' | 'nyc' {
  if (typeof input !== 'string') {
    throw new ValidationError(
      'City code must be a string',
      'city',
      input,
      'type must be string'
    );
  }

  const sanitized = sanitizeString(input, 10).toLowerCase();

  if (!ValidationRules.cityCode.allowedValues.includes(sanitized as any)) {
    throw new ValidationError(
      `Unsupported city code. ${ValidationRules.cityCode.description}`,
      'city',
      input,
      ValidationRules.cityCode.description
    );
  }

  return sanitized as 'dc' | 'nyc';
}

/**
 * Validate MCP tool parameters
 * 
 * WHY CENTRALIZED:
 * All MCP tool calls go through this function, ensuring
 * consistent validation across the entire API
 * 
 * USAGE:
 * ```typescript
 * try {
 *   const params = validateToolParams(toolName, rawParams);
 *   // params is now validated and sanitized
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     // Return helpful error to user
 *   }
 * }
 * ```
 */
export function validateToolParams(toolName: string, params: any): Record<string, any> {
  const validated: Record<string, any> = {};

  // All tools require a city parameter
  if (!params.city) {
    throw new ValidationError(
      'Missing required parameter: city',
      'city',
      undefined,
      'required'
    );
  }
  validated.city = validateCityCode(params.city);

  // Tool-specific validation
  switch (toolName) {
    case 'get_station_predictions':
      if (!params.stationName) {
        throw new ValidationError(
          'Missing required parameter: stationName',
          'stationName',
          undefined,
          'required'
        );
      }
      // Station name could be either a name or a code
      // Try code format first, then name format
      try {
        validated.stationName = validateStationCode(params.stationName);
      } catch {
        validated.stationName = validateStationName(params.stationName);
      }
      break;

    case 'search_stations':
      if (!params.query) {
        throw new ValidationError(
          'Missing required parameter: query',
          'query',
          undefined,
          'required'
        );
      }
      validated.query = validateSearchQuery(params.query);
      break;

    case 'get_stations_by_line':
      if (!params.lineCode) {
        throw new ValidationError(
          'Missing required parameter: lineCode',
          'lineCode',
          undefined,
          'required'
        );
      }
      validated.lineCode = validateLineCode(params.lineCode);
      break;

    case 'get_incidents':
    case 'get_elevator_incidents':
    case 'get_all_stations':
      // These tools only need city, which is already validated
      break;

    default:
      throw new ValidationError(
        `Unknown tool: ${toolName}`,
        'toolName',
        toolName,
        'must be a supported tool name'
      );
  }

  return validated;
}

/**
 * Validate JSON-RPC request structure
 * 
 * WHY NEEDED:
 * Malformed JSON-RPC requests can cause errors or security issues
 * Validate before processing to fail fast with clear errors
 * 
 * SPEC: JSON-RPC 2.0 (https://www.jsonrpc.org/specification)
 */
export function validateJsonRpcRequest(body: any): void {
  // Check jsonrpc version
  if (!body.jsonrpc || body.jsonrpc !== '2.0') {
    throw new ValidationError(
      'Invalid or missing jsonrpc version (must be "2.0")',
      'jsonrpc',
      body.jsonrpc,
      'must be "2.0"'
    );
  }

  // Check method
  if (!body.method || typeof body.method !== 'string') {
    throw new ValidationError(
      'Invalid or missing method',
      'method',
      body.method,
      'must be a non-empty string'
    );
  }

  // Validate method name format (prevent injection)
  if (!/^[a-zA-Z0-9_\/]+$/.test(body.method)) {
    throw new ValidationError(
      'Invalid method name format',
      'method',
      body.method,
      'must contain only letters, numbers, underscores, and forward slashes'
    );
  }

  // Check id (optional for notifications)
  if (body.id !== undefined && body.id !== null) {
    if (typeof body.id !== 'string' && typeof body.id !== 'number') {
      throw new ValidationError(
        'Invalid id type',
        'id',
        body.id,
        'must be a string, number, or null'
      );
    }
  }

  // Check params (optional)
  if (body.params !== undefined) {
    if (typeof body.params !== 'object' || body.params === null) {
      throw new ValidationError(
        'Invalid params type',
        'params',
        body.params,
        'must be an object or array'
      );
    }
  }
}
