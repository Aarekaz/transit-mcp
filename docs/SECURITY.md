# Security Architecture

This document explains the security measures implemented in Metro MCP and the rationale behind them.

## Table of Contents

- [Overview](#overview)
- [Authentication & Authorization](#authentication--authorization)
- [Rate Limiting](#rate-limiting)
- [MCP and Input Boundaries](#mcp-and-input-boundaries)
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

Metro MCP 5.0 delegates OAuth protocol ownership to `@cloudflare/workers-oauth-provider`. GitHub authenticates the person but does not issue the MCP access token. The Provider owns authorization-server and protected-resource discovery, PKCE S256, RFC 9207 issuer identifiers, RFC 8707 resource binding, RFC 9728 challenges, refresh rotation, revocation, and client storage in `OAUTH_KV`.

### Registration, consent, and scope

Clients register in this order:

1. A pre-registered client relationship, when available.
2. A Client ID Metadata Document (CIMD).
3. Temporary Dynamic Client Registration at `/register`.

DCR is a compatibility fallback and sunsets on **2027-06-30**. `global_fetch_strictly_public` is required so CIMD fetches stay on publicly routable addresses. GitHub login is followed by an explicit consent screen identifying the MCP client, canonical resource, and exact application permission `transit:read`. Invalid clients and redirect URIs are rendered locally and are not redirected.

### Resource and token boundaries

The production resource is exactly `https://metro-mcp.anuragd.me/mcp`; preview uses its own origin plus `/mcp`. `/sse` is only a URL alias rewritten before OAuth and is never an audience. Provider-issued access tokens last no more than 60 minutes. Refresh tokens last no more than 30 days and rotate on use. Registered clients expire after 90 days.

Bearer credentials are accepted only through `Authorization: Bearer`. Query parameters such as `access_token` and `token` are ignored. Protected requests also require Provider props with the exact normalized `transit:read` scope; missing scope returns `403`.

### Legacy JWT bridge

Metro MCP 5.0 no longer issues custom JWTs. The temporary resolver accepts an old token only when it has a valid signature and expiry, arrived in the Authorization header, and has an `aud` exactly matching canonical `/mcp`. Tokens without an audience and tokens bound to `/sse` require reauthorization. An otherwise compatible legacy JWT expires at the earlier of its embedded expiry and **2026-11-30T00:00:00Z**. Old DCR records are not imported.

## Rate Limiting

Rate limiting is an edge policy, not an application KV binding. Rules may use validated `Mcp-Method` and `Mcp-Name` as dimensions, but those headers are not authorization proof. Enforcement must also key on authenticated client/user context or trusted source identity. `RATE_LIMIT_KV` is not an active Worker binding in 5.0.

## MCP and Input Boundaries

### Host, Origin, and transport

The Worker derives trust from configured `MCP_PUBLIC_ORIGIN` and hostname allowlists, never from an incoming Host header. Undeclared or malformed Host and browser Origin values return `403`; origin-less desktop/server clients remain valid. Exact `POST`/`OPTIONS /sse` requests are rewritten to `/mcp` before the Provider sees them. `GET` and `DELETE`, slash variants, and legacy session-message URLs return `405`.

MCP 2026 clients send request metadata on every operation without an initialization handshake. Header/body version, method, and name mismatches are rejected. The server is stateless and does not advertise protocol sessions, resumability, or server push.

### MRTR request state

Modern ambiguous-station selection uses signed request state with a five-minute TTL. `MCP_REQUEST_STATE_KEY` is a dedicated stable secret of at least 32 bytes and must differ by environment. State binds the user and operation and rejects expiration, tampering, cross-user replay, a changed query, and selections outside the offered candidates. State is signed rather than encrypted, so it contains no secrets or unnecessary personal data.

### Tool input validation

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
bun audit
```

**6. Review Code for Security**
- Check all user input is validated
- Verify authentication is required
- Verify any Cloudflare edge policy keys on authenticated or trusted identity
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
# Store each value interactively; do not put it in shell history or config
bunx wrangler secret put MCP_REQUEST_STATE_KEY
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put WMATA_API_KEY
bunx wrangler secret put JWT_SECRET
```

Production and preview require distinct `OAUTH_KV` namespaces, GitHub OAuth apps/callbacks, and MRTR keys. The legacy JWT secret is retained only through the bridge and rollback windows.

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

**4. Keep exact runtime pins reviewed**
```bash
bun install --frozen-lockfile
bun audit
```

**5. Use Environment Variables Correctly**
```jsonc
// wrangler.jsonc contains public values and binding IDs only.
// Never place MCP_REQUEST_STATE_KEY, GITHUB_CLIENT_SECRET,
// WMATA_API_KEY, JWT_SECRET, or bearer tokens here.
```

**6. Preserve rollback boundaries**

- Keep the inactive `MetroMcpAgent` export and original `v1` migration.
- Do not add a Durable Object deletion migration during the 5.0 stabilization window.
- Roll back by restoring the prior Worker version and its prior binding configuration.
- Treat production deployment, DNS, secret changes, and old namespace deletion as separately approved operations.

### Logging and conformance

Structured telemetry is allowlisted. Never log access or refresh tokens, authorization codes, GitHub tokens, raw Provider props, request bodies, or MRTR responses. The conformance proxy binds only `127.0.0.1`, replaces inbound Authorization, supplies the operator token only from the process environment, uses manual redirects, and rejects remote targets unless `MCP_CONFORMANCE_ALLOW_REMOTE=1` is explicit.

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
- [ ] Any edge rate policy uses authenticated or trusted source identity
- [ ] Authentication is required for MCP endpoints
- [ ] HTTPS is enforced (Cloudflare Workers default)
- [ ] Security headers are applied
- [ ] Secrets are stored in environment variables
- [ ] Dependencies are up to date
- [ ] Security tests pass
- [ ] No secrets in code/logs
- [ ] Error messages don't leak internal details
- [ ] Production and preview OAuth storage, apps, callbacks, and MRTR keys are distinct
- [ ] Rollback assets and the original `v1` migration remain intact

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP Secure Headers](https://owasp.org/www-project-secure-headers/)
- [OAuth 2.1](https://oauth.net/2.1/)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [Content Security Policy](https://content-security-policy.com/)
