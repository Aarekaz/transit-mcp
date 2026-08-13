import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';

import type { Config } from '../config';
import { loadConfig } from '../config';
import type { TelemetryInput } from '../telemetry';
import type { Env } from '../types';
import { parseMetroMcpProps, requireTransitRead } from './context';
import { createMetroMcpServer } from './server';

function insufficientScope(): Response {
  return Response.json(
    {
      error: 'insufficient_scope',
      error_description: 'The transit:read scope is required.',
    },
    {
      status: 403,
      headers: {
        'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="transit:read"',
      },
    },
  );
}

/** Serve one authenticated stateless MCP request from Provider-owned props. */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  authInfo: AuthInfo | undefined,
  rawProps: unknown,
  config: Config = loadConfig(env),
  telemetry?: TelemetryInput,
): Promise<Response> {
  let props;
  try {
    props = requireTransitRead(parseMetroMcpProps(rawProps));
  } catch {
    return insufficientScope();
  }

  if (telemetry) {
    telemetry.clientId = props.clientId;
  }

  const handler = createMcpHandler(
    sdkContext => {
      if (telemetry) {
        telemetry.era = sdkContext.era;
        if (sdkContext.era === 'modern') {
          telemetry.protocolVersion = request.headers.get('MCP-Protocol-Version') ?? undefined;
          telemetry.mcpMethod = request.headers.get('Mcp-Method') ?? undefined;
          telemetry.mcpName = request.headers.get('Mcp-Name') ?? undefined;
        }
      }
      return createMetroMcpServer({
        env,
        era: sdkContext.era,
        authInfo: sdkContext.authInfo,
        props,
      });
    },
    {
      route: '/mcp',
      legacy: 'stateless',
      responseMode: 'auto',
      allowedHostnames: config.mcp.allowedHostnames,
      allowedOriginHostnames: config.mcp.allowedOriginHostnames,
      authContext: { props },
    },
  );

  return handler.fetch(request, authInfo ? { authInfo } : undefined);
}
