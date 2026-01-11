import { Env, AuthSession } from './types';
import { AuthManager, AuthError } from './auth';
import { detectResponseContext, addSecurityHeaders } from './middleware/security-headers';

export class OAuthHandler {
  addSecurityHeaders(response: Response): Response {
    // Detect response context from Content-Type
    // This will automatically use 'stream' CSP for SSE responses
    const context = detectResponseContext(response);

    // Apply context-appropriate security headers
    const secureResponse = addSecurityHeaders(response, context, true);

    // Add MCP-specific CORS headers
    const headers = new Headers(secureResponse.headers);
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version, Authorization');
    headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');

    return new Response(secureResponse.body, {
      status: secureResponse.status,
      statusText: secureResponse.statusText,
      headers
    });
  }

  async handleAuthorize(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const responseType = url.searchParams.get('response_type');
      const codeChallenge = url.searchParams.get('code_challenge');
      const codeChallengeMethod = url.searchParams.get('code_challenge_method');
      const state = url.searchParams.get('state') || '';

      // Validate required parameters
      if (!clientId) {
        return new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'Missing client_id parameter'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (responseType !== 'code') {
        return new Response(JSON.stringify({
          error: 'unsupported_response_type',
          error_description: 'Only response_type=code is supported'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // PKCE is required for MCP OAuth 2.1
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        return new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'PKCE with S256 is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify client exists in KV
      const clientData = await env.OAUTH_CLIENTS.get(`client:${clientId}`);
      if (!clientData) {
        return new Response(JSON.stringify({
          error: 'invalid_client',
          error_description: 'Client not found'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const client = JSON.parse(clientData);

      // Validate redirect URI if provided
      if (redirectUri && !client.redirect_uris.includes(redirectUri)) {
        return new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'Invalid redirect_uri'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const authManager = new AuthManager(env);

      // Generate OAuth state that includes MCP client info and PKCE challenge
      const oauthState = authManager.generateState();

      // Store PKCE challenge and client info temporarily (5 minutes)
      await env.OAUTH_CLIENTS.put(`pkce:${oauthState}`, JSON.stringify({
        clientId,
        redirectUri: redirectUri || client.redirect_uris[0],
        codeChallenge,
        codeChallengeMethod,
        mcpState: state
      }), { expirationTtl: 300 });

      const authUrl = authManager.generateAuthURL(oauthState);

      return Response.redirect(authUrl, 302);
    } catch (error) {
      return new Response(
        error instanceof AuthError ? error.message : 'OAuth configuration error',
        { status: error instanceof AuthError ? error.status : 500 }
      );
    }
  }

  async handleToken(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const authManager = new AuthManager(env);
      const contentType = request.headers.get('content-type') || '';

      let grantType: string | null = null;
      let code: string | null = null;
      let codeVerifier: string | null = null;
      let clientId: string | null = null;

      // Support both form-urlencoded and JSON
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const body = await request.formData();
        grantType = body.get('grant_type') as string;
        code = body.get('code') as string;
        codeVerifier = body.get('code_verifier') as string;
        clientId = body.get('client_id') as string;
      } else if (contentType.includes('application/json')) {
        const body = await request.json() as any;
        grantType = body.grant_type;
        code = body.code;
        codeVerifier = body.code_verifier;
        clientId = body.client_id;
      }

      if (grantType !== 'authorization_code' || !code) {
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Grant type must be authorization_code and code is required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (!codeVerifier) {
        return new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'code_verifier is required for PKCE'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Retrieve authorization code data
      const authCodeDataStr = await env.OAUTH_CLIENTS.get(`authcode:${code}`);
      if (!authCodeDataStr) {
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Invalid or expired authorization code'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const authCodeData = JSON.parse(authCodeDataStr);

      // Verify client ID matches
      if (clientId && authCodeData.clientId !== clientId) {
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Client ID mismatch'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Verify PKCE code_verifier against code_challenge
      const verified = await authManager.verifyPKCE(codeVerifier, authCodeData.codeChallenge);
      if (!verified) {
        return new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Invalid code_verifier'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Create session (expires in 90 days)
      const expiresAt = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60);
      const session: AuthSession = {
        userId: authCodeData.userId,
        userLogin: authCodeData.userLogin,
        expiresAt
      };

      // Generate JWT token
      const jwtToken = await authManager.generateJWT(session);

      // Delete used authorization code
      await env.OAUTH_CLIENTS.delete(`authcode:${code}`);

      return this.addSecurityHeaders(new Response(JSON.stringify({
        access_token: jwtToken,
        token_type: 'Bearer',
        expires_in: 90 * 24 * 60 * 60
      }), {
        headers: { 'Content-Type': 'application/json' }
      }));
    } catch (error) {
      const errorMessage = error instanceof AuthError ? error.message : 'Token exchange failed';
      const statusCode = error instanceof AuthError ? error.status : 400;

      return this.addSecurityHeaders(new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: errorMessage
      }), {
        status: statusCode,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
  }

  async handleRegister(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json() as { client_name?: string; redirect_uris?: string[] };
      const { client_name, redirect_uris } = body;

      if (!client_name || !redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
        return new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'client_name and redirect_uris array are required'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Validate redirect URIs
      for (const uri of redirect_uris) {
        try {
          new URL(uri);
        } catch {
          return new Response(JSON.stringify({
            error: 'invalid_request',
            error_description: `Invalid redirect URI: ${uri}`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      const authManager = new AuthManager(env);

      // Generate secure client ID and secret
      const clientId = 'mcp_' + authManager.generateState().substring(0, 32);
      const clientSecret = authManager.generateState();

      // Store client in KV (no expiration for persistent client registration)
      await env.OAUTH_CLIENTS.put(`client:${clientId}`, JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        client_name,
        redirect_uris,
        created_at: new Date().toISOString()
      }));

      return this.addSecurityHeaders(new Response(JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        client_name,
        redirect_uris
      }), {
        headers: {
          'Content-Type': 'application/json'
        }
      }));
    } catch (error) {
      return new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: 'Invalid request body'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async handleCallback(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const githubCode = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');

    if (error) {
      return this.addSecurityHeaders(new Response(`
        <html>
          <head><title>Metro MCP - OAuth Error</title></head>
          <body>
            <h1>Authorization Failed</h1>
            <p>Error: ${error}</p>
            <p>Please try again or contact support.</p>
          </body>
        </html>
      `, {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      }));
    }

    if (!githubCode || !state) {
      return this.addSecurityHeaders(new Response(`
        <html>
          <head><title>Metro MCP - OAuth Error</title></head>
          <body>
            <h1>Authorization Failed</h1>
            <p>No authorization code or state received.</p>
          </body>
        </html>
      `, {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      }));
    }

    try {
      const authManager = new AuthManager(env);

      // Retrieve PKCE data from KV using state
      const pkceDataStr = await env.OAUTH_CLIENTS.get(`pkce:${state}`);
      if (!pkceDataStr) {
        return this.addSecurityHeaders(new Response(`
          <html>
            <head><title>Metro MCP - OAuth Error</title></head>
            <body>
              <h1>Authorization Failed</h1>
              <p>Invalid or expired state parameter.</p>
            </body>
          </html>
        `, {
          status: 400,
          headers: { 'Content-Type': 'text/html' }
        }));
      }

      const pkceData = JSON.parse(pkceDataStr);

      // Exchange GitHub code for user info
      const githubAccessToken = await authManager.exchangeCodeForToken(githubCode);
      const user = await authManager.getUserInfo(githubAccessToken);

      // Generate MCP authorization code
      const mcpAuthCode = authManager.generateState();

      // Store authorization code with user info and PKCE challenge (valid for 10 minutes)
      await env.OAUTH_CLIENTS.put(`authcode:${mcpAuthCode}`, JSON.stringify({
        userId: user.id,
        userLogin: user.login,
        userName: user.name,
        userEmail: user.email,
        clientId: pkceData.clientId,
        redirectUri: pkceData.redirectUri,
        codeChallenge: pkceData.codeChallenge,
        createdAt: Date.now()
      }), { expirationTtl: 600 });

      // Clean up PKCE state
      await env.OAUTH_CLIENTS.delete(`pkce:${state}`);

      // Redirect back to MCP client with authorization code
      const redirectUrl = new URL(pkceData.redirectUri);
      redirectUrl.searchParams.set('code', mcpAuthCode);
      if (pkceData.mcpState) {
        redirectUrl.searchParams.set('state', pkceData.mcpState);
      }

      return Response.redirect(redirectUrl.toString(), 302);
    } catch (error) {
      return this.addSecurityHeaders(new Response(`
        <html>
          <head><title>Metro MCP - OAuth Error</title></head>
          <body>
            <h1>Authorization Failed</h1>
            <p>Error processing authorization: ${error instanceof Error ? error.message : 'Unknown error'}</p>
          </body>
        </html>
      `, {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      }));
    }
  }
}
