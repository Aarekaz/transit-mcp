import type { Env } from './types';

/** Single source of truth for the public Metro MCP release version. */
export const SERVER_VERSION = '6.0.0';

/** Protocol revision advertised by the public server metadata. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

export interface Config {
  mcp: {
    publicOrigin: string;
    resourceUri: string;
    allowedHostnames: string[];
    allowedOriginHostnames: string[];
    requestStateKey: string;
  };
  apis: { wmata: string };
  app: { environment: 'development' | 'preview' | 'production'; version: string };
}

const REQUIRED_STRING_ENV = [
  'MCP_PUBLIC_ORIGIN',
  'MCP_ALLOWED_HOSTNAMES',
  'MCP_ALLOWED_ORIGIN_HOSTNAMES',
  'MCP_REQUEST_STATE_KEY',
  'WMATA_API_KEY',
  'ENVIRONMENT',
] as const satisfies readonly (keyof Env)[];

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Parse a comma-separated allowlist into normalized, unique hostnames. */
export function parseHostnameList(value: string): string[] {
  const entries = value.split(',').map(entry => entry.trim());

  if (entries.length === 0 || entries.some(entry => !entry || !HOSTNAME_PATTERN.test(entry))) {
    throw new Error(
      'Hostname allowlist entries must be hostname only (no scheme, port, path, or wildcard)',
    );
  }

  return [...new Set(entries.map(entry => entry.toLowerCase()))];
}

/** Load the deployment contract and reject unsafe or internally inconsistent values. */
export function loadConfig(env: Env): Config {
  const missing = REQUIRED_STRING_ENV.filter(name => {
    const value = env[name];
    return typeof value !== 'string' || value.length === 0;
  });

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const publicOrigin = parsePublicOrigin(env.MCP_PUBLIC_ORIGIN, env.ENVIRONMENT).origin;

  const config: Config = {
    mcp: {
      publicOrigin,
      resourceUri: `${publicOrigin}/mcp`,
      allowedHostnames: parseHostnameList(env.MCP_ALLOWED_HOSTNAMES),
      allowedOriginHostnames: parseHostnameList(env.MCP_ALLOWED_ORIGIN_HOSTNAMES),
      requestStateKey: env.MCP_REQUEST_STATE_KEY,
    },
    apis: { wmata: env.WMATA_API_KEY },
    app: {
      environment: env.ENVIRONMENT,
      version: SERVER_VERSION,
    },
  };

  validateConfig(config);
  return config;
}

/** Validate a Config passed across a runtime trust boundary. */
export function validateConfig(config: Config): void {
  const origin = parsePublicOrigin(config.mcp.publicOrigin, config.app.environment);

  if (config.mcp.resourceUri !== `${config.mcp.publicOrigin}/mcp`) {
    throw new Error('MCP resource URI must equal MCP_PUBLIC_ORIGIN plus /mcp');
  }

  const allowedHostnames = parseHostnameList(config.mcp.allowedHostnames.join(','));
  parseHostnameList(config.mcp.allowedOriginHostnames.join(','));
  if (!allowedHostnames.includes(origin.hostname.toLowerCase())) {
    throw new Error('MCP_ALLOWED_HOSTNAMES must include the MCP_PUBLIC_ORIGIN hostname');
  }

  if (new TextEncoder().encode(config.mcp.requestStateKey).byteLength < 32) {
    throw new Error('MCP_REQUEST_STATE_KEY must be at least 32 bytes');
  }
  if (!['development', 'preview', 'production'].includes(config.app.environment)) {
    throw new Error('ENVIRONMENT must be one of development, preview, production');
  }
}

function parsePublicOrigin(
  value: string,
  environment: Config['app']['environment'],
): URL {
  if (value.endsWith('/')) {
    throw new Error('MCP_PUBLIC_ORIGIN must not end with a slash');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MCP_PUBLIC_ORIGIN must be a valid URL');
  }

  const isLoopback = url.hostname === 'localhost'
    || url.hostname.endsWith('.localhost')
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback && environment === 'development')) {
    throw new Error('MCP_PUBLIC_ORIGIN must use HTTPS except for loopback development');
  }
  if (url.pathname !== '/') {
    throw new Error('MCP_PUBLIC_ORIGIN must not contain a path');
  }
  if (url.search || url.hash) {
    throw new Error('MCP_PUBLIC_ORIGIN must not contain a query or fragment');
  }
  if (value !== url.origin) {
    throw new Error('MCP_PUBLIC_ORIGIN must be a canonical origin');
  }

  return url;
}
