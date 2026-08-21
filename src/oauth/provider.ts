import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

import type { Config } from '../config';
import { loadConfig } from '../config';
import { handleMcpRequest } from '../mcp/http-handler';
import { handlePublicRequest } from '../public-handler';
import type { TelemetryInput } from '../telemetry';
import type { Env } from '../types';
import { resolveLegacyToken } from './legacy-token';

/** Create an isolated Provider configuration for one Worker request. */
export function createOAuthProvider(
  env: Env,
  _ctx: ExecutionContext,
  config: Config = loadConfig(env),
  telemetry?: TelemetryInput,
): OAuthProvider<Env> {
  const protectedHandler: ExportedHandler<Env> & Pick<Required<ExportedHandler<Env>>, 'fetch'> = {
    fetch(request) {
      return handleMcpRequest(request, env, config, telemetry);
    },
  };
  const publicHandler: ExportedHandler<Env> = {
    fetch(request) {
      return handlePublicRequest(request, env, config);
    },
  };
  // Provider 0.10.3 rejects explicit HTTP issuers, but safely derives the
  // issuer from an absolute loopback token endpoint. Config validation limits
  // this exception to HTTP loopback in development.
  const authorizationServerMetadata = config.app.environment === 'development'
    && config.mcp.publicOrigin.startsWith('http://')
    ? {}
    : { authorization_servers: [config.mcp.publicOrigin] };

  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: protectedHandler,
    defaultHandler: publicHandler,
    authorizeEndpoint: `${config.mcp.publicOrigin}/authorize`,
    tokenEndpoint: `${config.mcp.publicOrigin}/token`,
    clientRegistrationEndpoint: `${config.mcp.publicOrigin}/register`,
    accessTokenTTL: 3_600,
    refreshTokenTTL: 2_592_000,
    clientRegistrationTTL: 7_776_000,
    scopesSupported: ['transit:read'],
    resourceMetadata: {
      resource: config.mcp.resourceUri,
      ...authorizationServerMetadata,
      scopes_supported: ['transit:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Metro MCP',
    },
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    resolveExternalToken: ({ token }) => resolveLegacyToken(token, env, config.mcp.resourceUri),
  });
}
