# Security Architecture

This document explains the security measures implemented in Metro MCP and the rationale behind them.

## Table of Contents

- [Overview](#overview)
- [Authentication & Authorization](#authentication--authorization)
- [Rate Limiting](#rate-limiting)
- [Input Validation](#input-validation)
- [Security Headers](#security-headers)
- [Security Best Practices](#security-best-practices)

## Overview

### Security Philosophy

Metro MCP follows a **defense-in-depth** approach:

1. **Multiple layers**: If one security measure fails, others provide protection
2. **Fail securely**: Errors default to denying access, not granting it
3. **Least privilege**: Grant minimum permissions necessary
4. **Assume breach**: Design as if attackers are already inside

### Threat Model

We protect against:

- **Unauthorized access**: OAuth 2.1 with PKCE
- **Abuse/DoS**: Rate limiting
- **Injection attacks**: Input validation and sanitization
- **XSS attacks**: Content Security Policy
- **Clickjacking**: X-Frame-Options
- **CSRF**: State parameter, PKCE

## Authentication & Authorization

### OAuth 2.1 with PKCE

**Why OAuth 2.1:**
- Industry standard for API authorization
- Widely supported by clients (like Claude Desktop)
- Delegated authentication (uses GitHub, don't handle passwords)
- Refresh tokens for long-lived access

**Why PKCE (Proof Key for Code Exchange):**
- Prevents authorization code interception attacks
- Required for public clients (mobile apps, desktop apps)
- No client secret needed (can't be kept secret in public clients)
- Forward-compatible with OAuth 2.1 requirements

### Flow

```
1. Client registers (POST /register)
   ← Returns client_id, client_secret

2. Client initiates auth (GET /authorize + code_challenge)
   → Redirects to GitHub OAuth
   
3. User authorizes on GitHub
   → GitHub redirects to /callback
   
4. Server exchanges code for token
   → Returns access_token (JWT)
   
5. Client uses token (Authorization: Bearer <token>)
   ✓ Verified on each request
```

### JWT Tokens

**Structure:**
```json
{
  "header": {
    "alg": "HS256",
    "typ": "JWT"
  },
  "payload": {
    "userId": "12345",
    "userLogin": "username",
    "exp": 1735689600,
    "iat": 1735603200
  },
  "signature": "<HMAC-SHA256 signature>"
}
```

**Why JWT:**
- Stateless (no server-side session storage)
- Self-contained (includes user info)
- Tamper-proof (signed with JWT_SECRET)
- Standard format (RFC 7519)

**Security Measures:**
- Signed with HMAC-SHA256
- 90-day expiration (configurable)
- Secret key must be 32+ characters
- Verified on every request

### Implementation

```typescript
// Generate JWT
const token = await authManager.generateJWT(session);

// Verify JWT
try {
  const session = await authManager.verifyJWT(token);
  // Token valid, proceed
} catch (error) {
  // Token invalid/expired, deny access
}
```

## Rate Limiting

### Why Rate Limiting

1. **Prevent DoS attacks**: Limit damage from malicious actors
2. **Fair usage**: Ensure resources are shared fairly
3. **Cost control**: Protect backend API quotas (WMATA, MTA)
4. **Performance**: Prevent system overload

### Implementation

**Algorithm**: Sliding Window Counter

```
Window: 60 seconds
Limit: 100 requests

Time Window: [0-60s] [60-120s] [120-180s]
             ╰─────╯   ╰─────╯    ╰─────╯
             100 req   resets      100 req
```

**Storage**: Cloudflare KV
```typescript
Key: rate_limit:{client_ip}:{window_timestamp}
Value: request_count
Expiration: 120 seconds (window + buffer)
```

**Limits by Endpoint:**
- OAuth endpoints: 200 requests/minute (auth flows need multiple requests)
- MCP endpoints: 100 requests/minute (standard API usage)
- Static endpoints: 50 requests/minute (less critical)

### Client Identification

```typescript
// Priority order:
1. CF-Connecting-IP (most reliable, set by Cloudflare)
2. X-Real-IP (proxy header)
3. X-Forwarded-For (standard but spoofable, use first IP)
4. "unknown" (fallback)
```

**Why IP-based:**
- Available for all requests (including unauthenticated)
- Reasonably unique per user
- Prevents abuse before authentication

### Error Handling

**When limit exceeded:**
```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1735689660
Retry-After: 45

{
  "jsonrpc": "2.0",
  "error": {
    "code": -32603,
    "message": "Too Many Requests",
    "data": {
      "retryAfter": 45
    }
  }
}
```

**Fail Open Strategy:**
If KV fails, allow request (availability > strict limiting)

```typescript
try {
  const count = await KV.get(key);
  // Check limit
} catch (error) {
  console.error('Rate limiter error:', error);
  return { allowed: true };  // Fail open
}
```

## Input Validation

### Why Input Validation

**Security:**
- Prevent injection attacks (XSS, SQL, command injection)
- Prevent path traversal
- Prevent malformed requests

**Data Integrity:**
- Ensure data is in expected format
- Prevent application errors
- Provide helpful error messages

### Validation Strategy

**1. Type Checking**
```typescript
if (typeof input !== 'string') {
  throw new ValidationError('Must be a string');
}
```

**2. Sanitization**
```typescript
// Remove dangerous characters
const sanitized = input
  .trim()
  .replace(/\0/g, '')          // Null bytes
  .replace(/[\x00-\x1F]/g, ''); // Control characters
```

**3. Format Validation**
```typescript
if (!/^[a-zA-Z0-9\s\-'.]+$/.test(sanitized)) {
  throw new ValidationError('Invalid characters');
}
```

**4. Length Limits**
```typescript
if (sanitized.length > maxLength) {
  throw new ValidationError('Too long');
}
```

**5. Whitelist (where possible)**
```typescript
const allowedCities = ['dc', 'nyc'];
if (!allowedCities.includes(city)) {
  throw new ValidationError('Invalid city');
}
```

### Validation Rules

**Station Names:**
- Pattern: `^[a-zA-Z0-9\s\-'.()&\/]+$`
- Max length: 100 characters
- Example: "Union Station", "L'Enfant Plaza"

**Station Codes:**
- Pattern: `^[A-Z0-9]+[NS]?$`
- Max length: 10 characters
- Example: "A01", "123N"

**Line Codes:**
- Pattern: `^[A-Z0-9\-\/]+$`
- Max length: 10 characters
- Example: "RD", "1", "A/C/E"

**Search Queries:**
- Pattern: `^[a-zA-Z0-9\s\-'.()&\/,]+$`
- Max length: 100 characters
- More permissive for natural language

**City Codes:**
- Whitelist: `['dc', 'nyc']`
- Strict validation prevents path traversal

### Implementation

```typescript
// Validate tool parameters
try {
  const validated = validateToolParams(toolName, params);
  // Use validated parameters safely
} catch (error) {
  if (error instanceof ValidationError) {
    return {
      error: {
        code: -32602,
        message: 'Invalid params',
        data: error.message
      }
    };
  }
}
```

## Security Headers

### Why Security Headers

HTTP security headers instruct browsers how to handle content safely:

1. **Content Security Policy (CSP)**: Prevent XSS
2. **X-Frame-Options**: Prevent clickjacking
3. **X-Content-Type-Options**: Prevent MIME sniffing
4. **Referrer-Policy**: Control information leakage
5. **Permissions-Policy**: Restrict browser features

### Content Security Policy (CSP)

**Why Adaptive CSP:**

Different response types need different policies:

**JSON Responses (MCP API):**
```
Content-Security-Policy: default-src 'none'; script-src 'none'; ...
```
- Strictest policy
- No scripts, no styles, no resources
- Protects against MIME confusion attacks

**HTML Responses (OAuth Callbacks):**
```
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; ...
```
- Allows inline scripts (needed for OAuth flow)
- Still blocks third-party resources
- Allows necessary functionality while maintaining security

**Why 'unsafe-inline' for OAuth:**
- OAuth callback pages need inline scripts to:
  - Extract authorization code from URL
  - Display code to user
  - Complete OAuth flow
- Pages are server-generated (no user content)
- Alternative (nonces) complicates deployment
- Acceptable tradeoff for this specific use case

### Other Security Headers

**X-Frame-Options: DENY**
- Prevents page from being embedded in frames
- Protects against clickjacking attacks
- This service doesn't need iframe embedding

**X-Content-Type-Options: nosniff**
- Prevents MIME sniffing
- Forces browser to respect Content-Type header
- Prevents JSON being rendered as HTML

**Referrer-Policy: strict-origin-when-cross-origin**
- Same-origin: Send full URL in referrer
- Cross-origin HTTPS: Send only origin
- Cross-origin HTTP: No referrer
- Balances privacy and functionality

**Permissions-Policy**
```
geolocation=(), microphone=(), camera=(), payment=(), usb=()
```
- Disables browser features we don't use
- Reduces attack surface
- Limits damage if XSS occurs

### Implementation

```typescript
// Automatic context detection
const response = createSecureJsonResponse(data);
// Applies JSON CSP automatically

// Manual context specification
const response = new Response(html);
return addSecurityHeaders(response, 'html');
```

## Security Best Practices

### For Developers

**1. Never Trust User Input**
```typescript
// Always validate
const city = validateCityCode(params.city);
const query = validateSearchQuery(params.query);
```

**2. Use TypeScript Strictly**
```typescript
// Enable in tsconfig.json
{
  "strict": true,
  "noUncheckedIndexedAccess": true
}
```

**3. Handle Errors Securely**
```typescript
// Don't leak internal details
try {
  await sensitiveOperation();
} catch (error) {
  // Log full error for debugging
  console.error('Internal error:', error);
  // Return generic message to client
  return { error: 'Operation failed' };
}
```

**4. Use Prepared Statements (if using SQL)**
```typescript
// We don't use SQL, but if we did:
db.query('SELECT * FROM stations WHERE id = ?', [stationId]);
// NOT: db.query(`SELECT * FROM stations WHERE id = '${stationId}'`);
```

**5. Keep Dependencies Updated**
```bash
# Regularly check for updates
npm audit
npm update
```

**6. Review Code for Security**
- Check all user input is validated
- Verify authentication is required
- Ensure rate limiting is applied
- Confirm security headers are set

**7. Test Security Features**
```typescript
it('should reject SQL injection attempts', () => {
  expect(() => validateQuery("'; DROP TABLE--")).toThrow();
});
```

### For Operators

**1. Use Strong Secrets**
```bash
# Generate secure JWT secret
openssl rand -hex 32

# Store securely in Cloudflare
wrangler secret put JWT_SECRET
```

**2. Monitor Rate Limits**
- Check for unusually high rejection rates
- Adjust limits if legitimate users are blocked
- Investigate patterns of abuse

**3. Review Logs Regularly**
```javascript
// Look for:
- Authentication failures
- Rate limit violations
- Validation errors
- Unusual access patterns
```

**4. Keep Wrangler Updated**
```bash
npm update wrangler
```

**5. Use Environment Variables Correctly**
```toml
# wrangler.toml
[vars]
PUBLIC_VALUE = "can be in git"  # OK

# Secret (use wrangler secret put)
# JWT_SECRET = "never in git"  # WRONG
```

### Incident Response

**If Security Issue Discovered:**

1. **Assess severity**: What data/systems are affected?
2. **Contain**: Can it be mitigated quickly?
3. **Fix**: Deploy patch
4. **Notify**: Inform affected users if needed
5. **Review**: How did it happen? How to prevent?

**If Abuse Detected:**

1. **Identify**: Which IPs/users?
2. **Block**: Add to rate limiter if needed
3. **Investigate**: Automated or targeted attack?
4. **Adjust**: Update rate limits or validation rules

## Security Checklist

- [ ] All user input is validated
- [ ] Rate limiting is enabled
- [ ] Authentication is required for MCP endpoints
- [ ] HTTPS is enforced (Cloudflare Workers default)
- [ ] Security headers are applied
- [ ] Secrets are stored in environment variables
- [ ] Dependencies are up to date
- [ ] Security tests pass
- [ ] No secrets in code/logs
- [ ] Error messages don't leak internal details

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP Secure Headers](https://owasp.org/www-project-secure-headers/)
- [OAuth 2.1](https://oauth.net/2.1/)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [Content Security Policy](https://content-security-policy.com/)
