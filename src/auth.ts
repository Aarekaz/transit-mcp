import { Env, User, AuthSession } from './types';

export class AuthError extends Error {
  constructor(message: string, public status: number = 401) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthManager {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  // Generate OAuth authorization URL
  generateAuthURL(state: string): string {
    if (!this.env.GITHUB_CLIENT_ID || !this.env.OAUTH_REDIRECT_URI) {
      throw new AuthError('OAuth not configured', 500);
    }

    const params = new URLSearchParams({
      client_id: this.env.GITHUB_CLIENT_ID,
      redirect_uri: this.env.OAUTH_REDIRECT_URI,
      scope: 'user:email',
      state: state,
      response_type: 'code'
    });

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  // Exchange OAuth code for access token
  async exchangeCodeForToken(code: string): Promise<string> {
    if (!this.env.GITHUB_CLIENT_ID || !this.env.GITHUB_CLIENT_SECRET) {
      throw new AuthError('OAuth not configured', 500);
    }

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.env.GITHUB_CLIENT_ID,
        client_secret: this.env.GITHUB_CLIENT_SECRET,
        code: code,
      }),
    });

    if (!response.ok) {
      throw new AuthError('Failed to exchange code for token');
    }

    const data = await response.json() as any;
    if (data.error) {
      throw new AuthError(`OAuth error: ${data.error_description || data.error}`);
    }

    return data.access_token;
  }

  // Get user info from GitHub
  async getUserInfo(accessToken: string): Promise<User> {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Metro-MCP-Server/1.0'
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new AuthError(`Failed to fetch user info: ${response.status} ${errorText}`);
    }

    const userData = await response.json() as any;
    
    // Validate required fields
    if (!userData.id || !userData.login) {
      throw new AuthError('Invalid user data received from GitHub');
    }
    
    return {
      id: userData.id.toString(),
      login: userData.login,
      name: userData.name || userData.login,
      email: userData.email || '',
      avatar_url: userData.avatar_url || '',
    };
  }

  // Generate JWT token
  async generateJWT(session: AuthSession): Promise<string> {
    if (!this.env.JWT_SECRET) {
      throw new AuthError('JWT secret not configured', 500);
    }

    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };

    const payload = {
      userId: session.userId,
      userLogin: session.userLogin,
      exp: session.expiresAt,
      iat: Math.floor(Date.now() / 1000)
    };

    const encoder = new TextEncoder();
    const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    
    const data = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    return `${data}.${signatureB64}`;
  }

  // Verify JWT token
  async verifyJWT(token: string): Promise<AuthSession> {
    if (!this.env.JWT_SECRET) {
      throw new AuthError('JWT secret not configured', 500);
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new AuthError('Invalid token format');
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64 || !signatureB64) {
      throw new AuthError('Invalid token format');
    }
    
    // Verify signature
    const encoder = new TextEncoder();
    const data = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));

    if (!isValid) {
      throw new AuthError('Invalid token signature');
    }

    // Decode payload
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as any;
    
    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      throw new AuthError('Token expired');
    }

    return {
      userId: payload.userId,
      userLogin: payload.userLogin,
      expiresAt: payload.exp
    };
  }

  // Extract token from request
  extractTokenFromRequest(request: Request): string | null {
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    const url = new URL(request.url);
    const accessToken = url.searchParams.get('access_token') || url.searchParams.get('token');
    if (accessToken) {
      return accessToken;
    }
    return null;
  }

  // Generate secure random state
  generateState(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  // Verify PKCE code_verifier against code_challenge
  async verifyPKCE(codeVerifier: string, codeChallenge: string): Promise<boolean> {
    try {
      // Hash the code_verifier with SHA-256
      const encoder = new TextEncoder();
      const data = encoder.encode(codeVerifier);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);

      // Base64url encode the hash
      const hashArray = new Uint8Array(hashBuffer);
      const base64 = btoa(String.fromCharCode(...hashArray));
      const base64url = base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      // Compare with the code_challenge
      return base64url === codeChallenge;
    } catch {
      return false;
    }
  }
}
