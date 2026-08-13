import { OAuthProvider } from '@cloudflare/workers-oauth-provider';

import type { Config } from '../config';
import { loadConfig } from '../config';
import { handleMcpRequest } from '../mcp/http-handler';
import { handlePublicRequest } from '../public-handler';
import type { TelemetryInput } from '../telemetry';
import type { Env } from '../types';
import { resolveLegacyToken } from './legacy-token';

type ProviderExecutionContext = ExecutionContext & { props?: unknown };

/** Create an isolated Provider configuration for one Worker request. */
export function createOAuthProvider(
  env: Env,
  _ctx: ExecutionContext,
  config: Config = loadConfig(env),
  telemetry?: TelemetryInput,
): OAuthProvider<Env> {
  const protectedHandler: ExportedHandler<Env> & Pick<Required<ExportedHandler<Env>>, 'fetch'> = {
    fetch(request, _handlerEnv, workerContext) {
      const props = (workerContext as ProviderExecutionContext).props;
      return handleMcpRequest(request, env, undefined, props, config, telemetry);
    },
  };
  const publicHandler: ExportedHandler<Env> = {
    fetch(request) {
      return handlePublicRequest(request, env, config);
    },
  };

  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: protectedHandler,
    defaultHandler: publicHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    accessTokenTTL: 3_600,
    refreshTokenTTL: 2_592_000,
    clientRegistrationTTL: 7_776_000,
    scopesSupported: ['transit:read'],
    resourceMetadata: {
      resource: config.mcp.resourceUri,
      authorization_servers: [config.mcp.publicOrigin],
      scopes_supported: ['transit:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Metro MCP',
    },
    clientIdMetadataDocumentEnabled: true,
    allowPlainPKCE: false,
    resolveExternalToken: ({ token }) => resolveLegacyToken(token, env, config.mcp.resourceUri),
  });
}
