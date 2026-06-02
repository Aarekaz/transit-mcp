import { Env, AuthSession } from './types';
import { OAuthHandler } from './oauth-handler';
import { AuthManager, AuthError } from './auth';
import { SERVER_VERSION, MCP_PROTOCOL_VERSION } from './config';
import { MetroMcpAgent, Props } from './mcp-agent';

export class Router {
  private oauthHandler = new OAuthHandler();


  private getServerInfoResponse(): Response {
    return new Response(JSON.stringify({
      name: 'Metro MCP',
      version: SERVER_VERSION,
      description: 'MCP server for US transit systems (DC Metro, NYC Subway)',
      protocolVersion: MCP_PROTOCOL_VERSION,
      status: 'operational',
      timestamp: new Date().toISOString(),
      author: 'Anurag Dhungana',
      links: {
        author: 'https://anuragd.me',
        github: 'https://github.com/anuragdhungana/metro-mcp',
        mcpServer: 'https://metro-mcp.anuragd.me/mcp',  // Recommended endpoint
        mcpServerLegacy: 'https://metro-mcp.anuragd.me/sse',  // Legacy alias (still works)
        website: 'https://metro-mcp.anuragd.me',
        documentation: 'https://github.com/anuragdhungana/metro-mcp/blob/main/README.md',
      },
      capabilities: {
        tools: {
          listChanged: true
        }
      },
      cities: [
        {
          code: 'dc',
          name: 'Washington DC Metro',
          system: 'WMATA',
          stations: 98,
          lines: 6,
          features: ['real-time', 'alerts', 'elevators', 'search', 'line-info', 'bus-routes', 'bus-stops', 'bus-positions', 'train-positions']
        },
        {
          code: 'nyc',
          name: 'New York City Subway',
          system: 'MTA',
          stations: 496,
          lines: 29,
          features: ['real-time', 'alerts', 'search', 'line-info', 'transfers', 'route-info']
        }
      ],
      stats: {
        totalStations: 594,
        totalLines: 35,
        citiesSupported: 2,
        toolsAvailable: 13
      },
      endpoints: {
        mcp: ['/mcp', '/sse'],  // Both endpoints supported (Streamable HTTP)
        mcpRecommended: '/mcp',  // Preferred endpoint name
        oauth: {
          authorize: '/authorize',
          token: '/token',
          register: '/register'
        },
        discovery: '/.well-known/oauth-authorization-server'
      },
      transport: {
        type: 'streamable-http',  // MCP Streamable HTTP (2025-06-18)
        note: 'MCP Streamable HTTP transport. Sessions live in a Durable Object via cloudflare/agents McpAgent.',
        supportsJSON: true,
        supportsSSEResponses: true,
        // Persistent server push: hibernatable WebSockets on the DO transport.
        supportsServerPush: true,
        // Last-Event-ID replay via DurableObjectEventStore.
        supportsResumability: true
      },
      authentication: {
        type: 'OAuth 2.1',
        pkce: true,
        provider: 'GitHub'
      },
      tools: [
        'get_station_predictions',
        'search_stations',
        'get_stations_by_line',
        'get_incidents',
        'get_elevator_incidents',
        'get_all_stations',
        'get_bus_predictions',
        'get_bus_routes',
        'get_bus_stops',
        'get_bus_positions',
        'get_train_positions',
        'get_station_transfers',
        'get_route_info'
      ]
    }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  async handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Rate limiting check
    const rateLimitResult = await this.checkRateLimit(request, env);
    if (!rateLimitResult.allowed) {
      return this.oauthHandler.addSecurityHeaders(new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: 'Too Many Requests',
            data: 'Rate limit exceeded. Please try again later.'
          }
        }), 
        { 
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        }
      ));
    }
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return this.oauthHandler.addSecurityHeaders(new Response(null, {
        headers: {
          'Content-Type': 'text/plain'
        },
      }));
    }

    // OAuth 2.0 Authorization Server Metadata (RFC 8414) - for MCP OAuth discovery
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      const baseUrl = `${url.protocol}//${url.host}`;
      const suffix = url.pathname.replace('/.well-known/oauth-protected-resource', '');
      const resourcePath = (!suffix || suffix === '/') ? '/mcp' : suffix;

      return new Response(JSON.stringify({
        resource: `${baseUrl}${resourcePath}`,
        authorization_servers: [baseUrl],
        scopes_supported: ['profile'],
        bearer_methods_supported: ['header', 'query']
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // OAuth 2.0 Authorization Server Metadata (RFC 8414) - for MCP OAuth discovery
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const baseUrl = `${url.protocol}//${url.host}`;
      return new Response(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        grant_types_supported: ['authorization_code', 'refresh_token'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        scopes_supported: ['profile'],
        // RFC 8707 — declare that this server understands the `resource` parameter
        // and issues audience-bound tokens when it is provided.
        resource_indicators_supported: true,
        authorization_response_iss_parameter_supported: true
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // OAuth endpoints
    if (url.pathname === '/authorize') {
      return this.oauthHandler.handleAuthorize(request, env);
    }

    if (url.pathname === '/token') {
      return this.oauthHandler.handleToken(request, env);
    }

    if (url.pathname === '/register') {
      return this.oauthHandler.handleRegister(request, env);
    }

    if (url.pathname === '/callback') {
      return this.oauthHandler.handleCallback(request, env);
    }

    // Root path: return server info on GET. POST to / is no longer an
    // MCP alias — clients use /mcp (recommended) or /sse (legacy).
    if (url.pathname === '/' && request.method === 'GET') {
      return this.getServerInfoResponse();
    }

    // MCP Streamable HTTP endpoint (protected). Both /mcp and /sse delegate
    // to the same MetroMcpAgent — /sse selects the legacy SSE transport so
    // existing clients keep working; /mcp uses transport: "auto" (Streamable
    // HTTP with SSE response fallback based on Accept header).
    if (url.pathname === '/sse' || url.pathname === '/mcp') {
      return this.serveAgent(request, env, ctx, url.pathname);
    }

    // Legacy compatibility - return server info for GET requests to other paths
    if (request.method === 'GET') {
      return this.getServerInfoResponse();
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * Verify the bearer token, propagate the authenticated user as Props on
   * the execution context, and hand the request off to the McpAgent's
   * fetch handler.
   *
   * The McpAgent SDK reads `ctx.props` to populate the DO's `props` field —
   * this is the workers-oauth-provider convention. Our JWT layer plays the
   * role of that OAuth provider.
   */
  private async serveAgent(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    pathname: string
  ): Promise<Response> {
    const origin = request.headers.get('Origin');
    if (origin && !this.isValidOrigin(origin)) {
      return this.createMCPErrorResponse(null, -32001, 'Forbidden', 'Invalid origin', 403);
    }

    const authResult = await this.authenticateRequest(request, env);
    if (!authResult.authenticated) {
      const baseUrl = `${new URL(request.url).protocol}//${new URL(request.url).host}`;
      return this.oauthHandler.addSecurityHeaders(new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32001,
            message: 'Unauthorized',
            data: authResult.error || 'Authentication required'
          }
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer realm="Metro MCP", authorization_uri="${baseUrl}/authorize", error="invalid_token"`
          }
        }
      ));
    }

    const props: Props = {
      userId: authResult.session!.userId,
      userLogin: authResult.session!.userLogin,
      audience: authResult.session!.audience
    };
    // ExecutionContext does not formally type `.props` — the workers-oauth-provider
    // convention attaches it at runtime and McpAgent.serve reads it from there.
    (ctx as ExecutionContext & { props?: Props }).props = props;

    // /sse uses the legacy SSE transport (one stream per request).
    // /mcp uses transport: "auto" — Streamable HTTP with SSE response fallback.
    const transport = pathname === '/sse' ? 'sse' : 'auto';
    const handler = MetroMcpAgent.serve(pathname, {
      binding: 'MCP_SESSION',
      transport
    });

    const response = await handler.fetch(request, env, ctx);
    return this.oauthHandler.addSecurityHeaders(response);
  }
  isValidOrigin(origin: string): boolean {
    try {
      const originUrl = new URL(origin);
      return originUrl.protocol === 'https:' || originUrl.protocol === 'http:';
    } catch {
      return false;
    }
  }

  createMCPErrorResponse(
    id: string | number | null,
    code: number,
    message: string,
    data?: any,
    status: number = 400
  ): Response {
    const errorResponse = {
      jsonrpc: '2.0' as const,
      id: id || 0,
      error: { code, message, data }
    };
    
    const response = new Response(JSON.stringify(errorResponse), {
      status,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return this.oauthHandler.addSecurityHeaders(response);
  }

  async checkRateLimit(_request: Request, _env: Env): Promise<{allowed: boolean, remaining: number}> {
    // Simple rate limiting: 100 requests per minute per IP
    // In production, you'd use Cloudflare KV or Durable Objects for rate limiting
    // You would get clientIP and create a key like: `rate_limit:${clientIP}:${Math.floor(Date.now() / 60000)}`
    const maxRequestsPerMinute = 100;
    
    // For now, we'll allow all requests but add the structure for future implementation
    return {
      allowed: true,
      remaining: maxRequestsPerMinute
    };
  }

  async authenticateRequest(request: Request, env: Env): Promise<{authenticated: boolean, session?: AuthSession, error?: string}> {
    try {
      const authManager = new AuthManager(env);
      const token = authManager.extractTokenFromRequest(request);

      if (!token) {
        return { authenticated: false, error: 'No authentication token provided' };
      }

      const session = await authManager.verifyJWT(token);

      // RFC 8707 audience enforcement.
      // - Token with aud → must match the request's canonical MCP resource
      // - Token without aud → grandfathered (legacy), accept with a console warning.
      //   Old tokens drain naturally as their 90-day TTL expires.
      if (!authManager.verifyAudience(session, request.url)) {
        return { authenticated: false, error: 'Token audience does not match this resource (RFC 8707)' };
      }
      if (!session.audience) {
        console.warn(
          `[deprecation] Legacy token without 'aud' claim accepted for user ${session.userLogin}. ` +
          `Re-authenticate with a 'resource' parameter to bind future tokens.`
        );
      }

      return { authenticated: true, session };
    } catch (error) {
      if (error instanceof AuthError) {
        return { authenticated: false, error: error.message };
      }
      return { authenticated: false, error: 'Authentication failed' };
    }
  }
}
