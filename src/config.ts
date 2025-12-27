/**
 * Configuration Management
 * 
 * WHY THIS MODULE:
 * Centralizes all configuration in one place, making it easy to:
 * 1. Understand what configuration exists
 * 2. Update configuration values
 * 3. Validate required configuration
 * 4. Provide sensible defaults
 * 5. Document WHY each config exists
 * 
 * ARCHITECTURE DECISION:
 * We load configuration from Cloudflare Workers environment variables
 * rather than a config file because:
 * - Environment vars are the standard for Workers
 * - Secrets are encrypted and never exposed in code
 * - Different environments (dev/staging/prod) can have different values
 * - No need to rebuild code to change configuration
 */

import { Env } from './types';

/**
 * Configuration interface
 * 
 * WHY SEPARATE INTERFACE:
 * - Documents all available configuration
 * - Enables IDE autocomplete
 * - Type-safe configuration access
 */
export interface Config {
  // OAuth Configuration
  oauth: {
    github: {
      clientId: string;
      clientSecret: string;
    };
    redirectUri: string;
  };

  // API Keys
  apis: {
    wmata: string;  // DC Metro API key
  };

  // Security
  security: {
    jwtSecret: string;
    jwtExpirationSeconds: number;
  };

  // Rate Limiting
  rateLimit: {
    enabled: boolean;
    maxRequestsPerMinute: number;
    windowSeconds: number;
  };

  // Application
  app: {
    environment: 'development' | 'staging' | 'production';
    version: string;
  };
}

/**
 * Load and validate configuration from environment
 * 
 * WHY VALIDATION:
 * Fail fast if configuration is missing or invalid.
 * Better to crash at startup than to fail mid-request.
 * 
 * USAGE:
 * ```typescript
 * const config = loadConfig(env);
 * const apiKey = config.apis.wmata;
 * ```
 * 
 * @param env - Cloudflare Workers environment
 * @returns Validated configuration object
 * @throws Error if required configuration is missing
 */
export function loadConfig(env: Env): Config {
  // Validate required environment variables
  const requiredVars = [
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'OAUTH_REDIRECT_URI',
    'WMATA_API_KEY',
    'JWT_SECRET'
  ];

  const missing = requiredVars.filter(varName => !env[varName as keyof Env]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      `Please check your wrangler.toml and .dev.vars files.`
    );
  }

  // Build configuration object
  return {
    oauth: {
      github: {
        clientId: env.GITHUB_CLIENT_ID!,
        clientSecret: env.GITHUB_CLIENT_SECRET!,
      },
      redirectUri: env.OAUTH_REDIRECT_URI!,
    },

    apis: {
      wmata: env.WMATA_API_KEY!,
    },

    security: {
      jwtSecret: env.JWT_SECRET!,
      // WHY 90 DAYS:
      // Balance between security and user experience
      // - Long enough: Users don't need to re-auth frequently
      // - Short enough: Compromised tokens expire reasonably quickly
      jwtExpirationSeconds: 90 * 24 * 60 * 60,  // 90 days
    },

    rateLimit: {
      enabled: true,
      // WHY 100 REQUESTS/MIN:
      // - Generous for legitimate users
      // - Protects against abuse and DoS
      // - Matches free tier limits of backend APIs
      maxRequestsPerMinute: 100,
      windowSeconds: 60,
    },

    app: {
      // WHY ENVIRONMENT DETECTION:
      // Different environments may need different behavior
      // (e.g., more logging in dev, stricter validation in prod)
      environment: detectEnvironment(env),
      version: '1.0.0',
    },
  };
}

/**
 * Detect environment from configuration
 * 
 * WHY NEEDED:
 * Different environments may need different behavior:
 * - Development: More logging, relaxed rate limits
 * - Staging: Test configuration with production-like settings
 * - Production: Strict settings, optimized performance
 * 
 * DETECTION STRATEGY:
 * 1. Check explicit ENVIRONMENT variable
 * 2. Detect from URL (localhost = dev, *.workers.dev = staging/prod)
 * 3. Default to production (safest)
 */
function detectEnvironment(env: Env): 'development' | 'staging' | 'production' {
  // Check explicit environment variable
  if (env.ENVIRONMENT) {
    const envLower = env.ENVIRONMENT.toLowerCase();
    if (envLower === 'development' || envLower === 'dev') {
      return 'development';
    }
    if (envLower === 'staging' || envLower === 'stage') {
      return 'staging';
    }
  }

  // Detect from redirect URI
  if (env.OAUTH_REDIRECT_URI) {
    if (env.OAUTH_REDIRECT_URI.includes('localhost')) {
      return 'development';
    }
  }

  // Default to production (safest)
  return 'production';
}

/**
 * Get rate limit configuration for a specific endpoint type
 * 
 * WHY DIFFERENT CONFIGS:
 * Different endpoints have different requirements:
 * - OAuth endpoints: Higher limits (auth flows need multiple requests)
 * - MCP endpoints: Standard limits
 * - Static endpoints: Lower limits (less critical)
 * 
 * USAGE:
 * ```typescript
 * const rlConfig = getRateLimitConfig(config, 'oauth');
 * ```
 */
export function getRateLimitConfig(
  config: Config,
  endpointType: 'oauth' | 'mcp' | 'static' = 'mcp'
): { maxRequests: number; windowSeconds: number } {
  const base = config.rateLimit;

  switch (endpointType) {
    case 'oauth':
      // WHY 2X FOR OAUTH:
      // OAuth flows need multiple requests:
      // 1. GET /authorize
      // 2. Redirect to GitHub
      // 3. GET /callback
      // 4. POST /token
      // Higher limits prevent legitimate users from being blocked
      return {
        maxRequests: base.maxRequestsPerMinute * 2,
        windowSeconds: base.windowSeconds,
      };

    case 'static':
      // WHY 0.5X FOR STATIC:
      // Static endpoints are less critical
      // Lower limits conserve resources
      return {
        maxRequests: Math.floor(base.maxRequestsPerMinute * 0.5),
        windowSeconds: base.windowSeconds,
      };

    case 'mcp':
    default:
      return {
        maxRequests: base.maxRequestsPerMinute,
        windowSeconds: base.windowSeconds,
      };
  }
}

/**
 * Validate configuration at runtime
 * 
 * WHY RUNTIME VALIDATION:
 * Catches configuration errors early, before they cause issues.
 * 
 * CHECKS:
 * - URLs are valid
 * - Numeric values are in acceptable ranges
 * - Required relationships are maintained
 * 
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: Config): void {
  // Validate URLs
  try {
    new URL(config.oauth.redirectUri);
  } catch {
    throw new Error(`Invalid OAuth redirect URI: ${config.oauth.redirectUri}`);
  }

  // Validate JWT secret length
  if (config.security.jwtSecret.length < 32) {
    throw new Error(
      'JWT secret must be at least 32 characters for security. ' +
      'Generate with: openssl rand -hex 32'
    );
  }

  // Validate rate limit values
  if (config.rateLimit.maxRequestsPerMinute < 1) {
    throw new Error('Rate limit maxRequestsPerMinute must be at least 1');
  }

  if (config.rateLimit.windowSeconds < 1) {
    throw new Error('Rate limit windowSeconds must be at least 1');
  }

  // Validate JWT expiration
  if (config.security.jwtExpirationSeconds < 60) {
    throw new Error('JWT expiration must be at least 60 seconds');
  }
}
