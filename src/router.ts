import { Env, AuthSession } from './types';
import { MCPRequest, MCPResponse, MCPSession } from './mcp-types';
import { MCPHandler } from './mcp-handler';
import { OAuthHandler } from './oauth-handler';
import { AuthManager, AuthError } from './auth';
import { createSSEResponse } from './utils/sse-formatter';

export class Router {
  private mcpHandler = new MCPHandler();
  private oauthHandler = new OAuthHandler();


  private getServerInfoResponse(): Response {
    return new Response(JSON.stringify({
      name: 'Metro MCP',
      version: '3.0.0',
      description: 'MCP server for US transit systems (DC Metro, NYC Subway)',
      protocolVersion: '2025-06-18',
      status: 'operational',
      timestamp: new Date().toISOString(),
      lastUpdated: '2025-12-27',
      author: 'Anurag Dhungana',
      links: {
        author: 'https://anuragd.me',
        github: 'https://github.com/anuragdhungana/metro-mcp',
        mcpServer: 'https://metro-mcp.anuragd.me/sse',
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
        mcp: '/sse',
        oauth: {
          authorize: '/authorize',
          token: '/token',
          register: '/register'
        },
        discovery: '/.well-known/oauth-authorization-server'
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

  async handleRequest(request: Request, env: Env): Promise<Response> {
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
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        scopes_supported: ['profile']
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

    // Root path - return server info for GET, handle MCP for POST
    if (url.pathname === '/') {
      if (request.method === 'GET') {
        // Return unauthenticated server info for validation and discovery
        return this.getServerInfoResponse();
      }
      // POST requests to / are MCP protocol requests (require auth)
      return this.handleMCPRequest(request, env);
    }

    // SSE endpoint for MCP protocol (protected)
    if (url.pathname === '/sse') {
      return this.handleSSE(request, env);
    }

    // Legacy compatibility - return server info for GET requests to other paths
    if (request.method === 'GET') {
      return this.getServerInfoResponse();
    }

    return new Response('Not Found', { status: 404 });
  }

  async handleMCPRequest(request: Request, env: Env): Promise<Response> {
    // Validate Origin header to prevent DNS rebinding attacks
    const origin = request.headers.get('Origin');
    if (origin && !this.isValidOrigin(origin)) {
      return new Response('Invalid origin', { status: 403 });
    }

    // Check authentication for MCP endpoints
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

    if (request.method === 'POST') {
      try {
        const body = await request.json() as MCPRequest;

        if (!body.jsonrpc || body.jsonrpc !== '2.0') {
          return this.createMCPErrorResponse(body.id || 0, -32600, 'Invalid Request: Missing or invalid jsonrpc field');
        }

        const response = await this.mcpHandler.processMCPMethod(body, env);

        // Per JSON-RPC 2.0 spec, notifications (methods starting with 'notifications/')
        // should not receive responses. Return 204 No Content for notifications.
        if (body.method?.startsWith('notifications/')) {
          return this.oauthHandler.addSecurityHeaders(new Response(null, { status: 204 }));
        }

        const jsonResponse = new Response(JSON.stringify(response), {
          headers: {
            'Content-Type': 'application/json'
          },
        });
        return this.oauthHandler.addSecurityHeaders(jsonResponse);
      } catch (error) {
        const errorResponse: MCPResponse = {
          jsonrpc: '2.0',
          id: 0,
          error: {
            code: -32700,
            message: 'Parse error',
            data: error instanceof Error ? error.message : 'Unknown error'
          }
        };
        
        const errorJsonResponse = new Response(JSON.stringify(errorResponse), {
          status: 400,
          headers: {
            'Content-Type': 'application/json'
          },
        });
        return this.oauthHandler.addSecurityHeaders(errorJsonResponse);
      }
    }

    return new Response('Method not allowed', { status: 405 });
  }

  /**
   * Handle SSE endpoint according to MCP Streamable HTTP spec (2025-06-18)
   *
   * POST requests:
   * - Check Accept header to determine response format (JSON vs SSE)
   * - Validate session ID (except for initialize)
   * - Return responses either as JSON or SSE based on client preference
   *
   * GET requests:
   * - Establish persistent SSE connection for server-to-client messages
   * - Support resumability via Last-Event-ID header
   */
  async handleSSE(request: Request, env: Env): Promise<Response> {
    // Validate Origin header to prevent DNS rebinding attacks
    const origin = request.headers.get('Origin');
    if (origin && !this.isValidOrigin(origin)) {
      return new Response('Invalid origin', { status: 403 });
    }

    // Check protocol version (default to 2025-03-26 if omitted)
    const protocolVersion = request.headers.get('Mcp-Protocol-Version') || '2025-03-26';
    const supportedVersions = ['2025-03-26', '2025-06-18'];

    if (!supportedVersions.includes(protocolVersion)) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: 'Unsupported protocol version',
            data: `Supported versions: ${supportedVersions.join(', ')}`
          }
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // Check authentication for all SSE endpoints
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

    // Handle GET requests for SSE stream (Server → Client messages)
    if (request.method === 'GET') {
      return this.handleGETSSE(request, env);
    }

    // Handle POST requests (Client → Server requests)
    if (request.method === 'POST') {
      return this.handlePOSTSSE(request, env, authResult.session!);
    }

    return new Response('Method not allowed', { status: 405 });
  }

  /**
   * Handle GET /sse - Persistent SSE connection for server-to-client messages
   */
  private async handleGETSSE(request: Request, env: Env): Promise<Response> {
    // Validate session ID
    const sessionId = request.headers.get('Mcp-Session-Id');
    if (!sessionId) {
      return new Response('Mcp-Session-Id header required', { status: 400 });
    }

    // Validate session exists
    const sessionData = await env.MCP_SESSIONS?.get(`session:${sessionId}`);
    if (!sessionData) {
      return new Response('Session not found', { status: 404 });
    }

    // Support resumability via Last-Event-ID
    // In a full implementation, we would:
    // 1. Parse the session: const session: MCPSession = JSON.parse(sessionData);
    // 2. Get Last-Event-ID header and calculate startEventId
    // 3. Replay missed events from a message queue starting from startEventId

    // Create persistent SSE stream
    // Note: Cloudflare Workers have connection time limits (~100 seconds)
    const stream = new ReadableStream({
      start(controller) {
        // Send initial comment to establish connection
        controller.enqueue(
          new TextEncoder().encode(`: Connected to Metro MCP (session: ${sessionId})\n\n`)
        );

        // In a full implementation, this would:
        // 1. Listen for server-initiated notifications from a message queue
        // 2. Send them as SSE events with incrementing IDs
        // 3. Handle connection lifecycle and cleanup

        // For now, keep connection open until client closes
        // Production would use Durable Objects for persistent connections
      },
      cancel() {
        // Cleanup when client closes connection
        console.log(`SSE connection closed for session: ${sessionId}`);
      }
    });

    const sseResponse = new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });

    return this.oauthHandler.addSecurityHeaders(sseResponse);
  }

  /**
   * Handle POST /sse - Client requests with optional SSE response
   */
  private async handlePOSTSSE(
    request: Request,
    env: Env,
    authSession: AuthSession
  ): Promise<Response> {
    // Parse request body
    let body: MCPRequest;
    try {
      body = await request.json() as MCPRequest;
    } catch (error) {
      const errorResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: 0,
        error: {
          code: -32700,
          message: 'Parse error',
          data: error instanceof Error ? error.message : 'Unknown error'
        }
      };

      return this.oauthHandler.addSecurityHeaders(new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    // Validate JSON-RPC 2.0 format
    if (!body.jsonrpc || body.jsonrpc !== '2.0') {
      return this.createMCPErrorResponse(
        body.id || 0,
        -32600,
        'Invalid Request: Missing or invalid jsonrpc field'
      );
    }

    // Extract and validate session ID (except for initialize)
    const sessionId = request.headers.get('Mcp-Session-Id');
    const isInitialize = body.method === 'initialize';

    if (!isInitialize) {
      if (!sessionId) {
        return this.createMCPErrorResponse(
          body.id,
          -32001,
          'Session required',
          'Mcp-Session-Id header missing for non-initialize request'
        );
      }

      // Validate session exists
      const sessionData = await env.MCP_SESSIONS?.get(`session:${sessionId}`);
      if (!sessionData) {
        return new Response('Session not found', { status: 404 });
      }
    }

    // Process MCP method
    let response: MCPResponse;
    let newSessionId: string | undefined;

    if (isInitialize) {
      // Handle initialize with session creation
      const result = await this.mcpHandler.handleInitialize(
        body.id,
        env,
        authSession.userId
      );
      response = result.response;
      newSessionId = result.sessionId;
    } else {
      // Handle other methods
      response = await this.mcpHandler.processMCPMethod(body, env, sessionId!);
    }

    // Handle notifications - return 202 Accepted with no body
    if (body.method?.startsWith('notifications/')) {
      return this.oauthHandler.addSecurityHeaders(new Response(null, { status: 202 }));
    }

    // Parse Accept header to determine response format
    const acceptHeader = request.headers.get('Accept') || 'application/json';
    const wantsSSE = acceptHeader.includes('text/event-stream');

    if (wantsSSE) {
      // Client wants SSE format
      const session = newSessionId
        ? await this.getSession(newSessionId, env)
        : await this.getSession(sessionId!, env);

      const eventId = `${session.lastEventId}`;

      // Increment event ID for next message
      session.lastEventId++;
      await env.MCP_SESSIONS?.put(
        `session:${session.sessionId}`,
        JSON.stringify(session),
        { expirationTtl: 86400 }
      );

      const sseResponse = createSSEResponse(response, eventId);

      // Add session ID header for initialize
      if (newSessionId) {
        sseResponse.headers.set('Mcp-Session-Id', newSessionId);
      }

      return this.oauthHandler.addSecurityHeaders(sseResponse);
    } else {
      // Client wants JSON format (default behavior)
      const jsonResponse = new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' }
      });

      // Add session ID header for initialize
      if (newSessionId) {
        jsonResponse.headers.set('Mcp-Session-Id', newSessionId);
      }

      return this.oauthHandler.addSecurityHeaders(jsonResponse);
    }
  }

  /**
   * Retrieve session from KV storage
   */
  private async getSession(sessionId: string, env: Env): Promise<MCPSession> {
    const sessionData = await env.MCP_SESSIONS?.get(`session:${sessionId}`);
    if (!sessionData) {
      throw new Error('Session not found');
    }
    return JSON.parse(sessionData);
  }

  isValidOrigin(origin: string): boolean {
    try {
      const originUrl = new URL(origin);
      // Allow specific domains for production
      const allowedHosts = [
        'localhost',
        '127.0.0.1',
        'claude.ai',
        'api.claude.ai'
      ];
      const allowedDomains = [
        '.anthropic.com',
        '.claude.ai',
        '.modelcontextprotocol.io'
      ];
      
      return allowedHosts.includes(originUrl.hostname) || 
             allowedDomains.some(domain => originUrl.hostname.endsWith(domain));
    } catch {
      return false;
    }
  }

  createMCPErrorResponse(id: string | number | null, code: number, message: string, data?: any): Response {
    const errorResponse: MCPResponse = {
      jsonrpc: '2.0',
      id: id || 0,
      error: { code, message, data }
    };
    
    return new Response(JSON.stringify(errorResponse), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
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
      return { authenticated: true, session };
    } catch (error) {
      if (error instanceof AuthError) {
        return { authenticated: false, error: error.message };
      }
      return { authenticated: false, error: 'Authentication failed' };
    }
  }
}
