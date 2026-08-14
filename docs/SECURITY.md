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

The active security boundaries are:

- **Unauthorized access**: OAuth 2.1 with PKCE
- **Abuse/DoS**: Operator-managed Cloudflare edge policy; the Worker has no application rate limiter
- **Untrusted input boundaries**: SDK schemas, field-specific domain handling, and non-HTML MCP results
- **Browser-rendered content**: Escaped server-rendered OAuth HTML with a no-script CSP
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

The production resource is exactly `https://metro-mcp.anuragd.me/mcp`; preview uses its own origin plus `/mcp`. `/sse` is only a URL alias rewritten before OAuth and is never an audience. Provider-issued access tokens last no more than 60 minutes. Refresh tokens last no more than 30 days and rotate on use.

Dynamically registered clients expire after 90 days. Pre-registered configured clients are not governed by the DCR TTL and persist until revoked or removed under their own lifecycle. CIMD supplies resolved metadata and is not a stored DCR record.

Bearer credentials are accepted only through `Authorization: Bearer`. Query parameters such as `access_token` and `token` are ignored. Protected requests also require Provider props with the exact normalized `transit:read` scope; missing scope returns `403`.

### Legacy JWT bridge

Metro MCP 5.0 no longer issues custom JWTs. The temporary resolver accepts an old token only when it has a valid signature and expiry, arrived in the Authorization header, and has an `aud` exactly matching canonical `/mcp`. Tokens without an audience and tokens bound to `/sse` require reauthorization. An otherwise compatible legacy JWT expires at the earlier of its embedded expiry and **2026-11-30T00:00:00Z**. Old DCR records are not imported.

## Rate Limiting

Metro MCP 5.0 has no application rate-limiter implementation or KV binding. Rate limiting, when configured, is operator-managed Cloudflare edge policy outside this repository. Rules may use validated `Mcp-Method` and `Mcp-Name` as dimensions, but those headers are not authorization proof. Enforcement must also key on authenticated client/user context or trusted source identity. `RATE_LIMIT_KV` is not an active Worker binding in 5.0.

## MCP and Input Boundaries

### Host, Origin, and transport

The Worker derives trust from configured `MCP_PUBLIC_ORIGIN` and hostname allowlists, never from an incoming Host header. Undeclared or malformed Host and browser Origin values return `403`; origin-less desktop/server clients remain valid. Exact `POST`/`OPTIONS /sse` requests are rewritten to `/mcp` before the Provider sees them. `GET` and `DELETE`, slash variants, and legacy session-message URLs return `405`.

MCP 2026 clients send request metadata on every operation without an initialization handshake. Header/body version, method, and name mismatches are rejected. The server is stateless and does not advertise protocol sessions, resumability, or server push.

### MRTR request state

Modern ambiguous-station selection uses signed request state with a five-minute TTL. `MCP_REQUEST_STATE_KEY` is a dedicated stable secret of at least 32 bytes and must differ by environment. State binds the user and operation and rejects expiration, tampering, cross-user replay, a changed query, and selections outside the offered candidates. State is signed rather than encrypted, so it contains no secrets or unnecessary personal data.

### Tool input schemas and downstream handling

The active SDK v2 registrations define a JSON Schema through Zod for every tool. JSON Schema and Zod enforce the documented types, requiredness, object shape, and enums where present. For example, city fields use the supported-city enum, while optional numeric coordinates remain optional numbers. A description such as "7-digit regional bus stop ID" is documentation unless the corresponding schema also declares that constraint.

Validation beyond the wire schema is field-specific:

- Station searches normalize case and whitespace where needed, then resolve names and identifiers against transit-domain data. Resource and transfer lookups reject unknown cities or identifiers.
- Thrown WMATA failures and other uncaught non-cancellation adapter errors are mapped to operational tool errors by the shared tool-error boundary. MTA prediction-feed failures are skipped, so predictions may be partial or empty. MTA incident-feed failures return empty incidents. Abort failures rethrow in both MTA paths, and MCP protocol errors keep their own semantics.
- Path and query values are encoded only where the active transit adapter does so. The optional WMATA bus-route filter uses URL encoding; other fields rely on domain lookup, numeric types, or their adapter contract. This is not a universal character or path constraint.
- Successful tool results are returned as structured JSON plus a JSON-serialized text representation. That structured JSON and text are not rendered as trusted HTML by the Worker. Separately generated OAuth HTML escapes interpolated values.

Tool inputs are not universally sanitized. Many strings intentionally have no generic regex or maximum-length constraint, including station names, station searches, line/route identifiers, and bus stop IDs. The server does not execute tool input as SQL or shell commands. Any new field constraint must be added to the active Zod schema and covered by a wire-level test before it is documented as enforced.

## Security Headers

The outer Worker applies response-type-aware security headers after routing. It preserves any route-owned header and fills only headers that are absent.

- MCP JSON responses receive a deny-by-default CSP with scripts, styles, images, connections, frames, base URIs, and form actions disabled.
- Event streams receive a deny-by-default CSP that allows only same-origin connections.
- OAuth consent and error forms are server-rendered with escaped interpolated values and no scripts. Their exact CSP is `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`.
- OAuth forms also set `Cache-Control: no-store`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- Other responses receive the shared `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and disabled legacy XSS-filter headers when a route has not already supplied a stricter value.

The OAuth pages contain no untrusted HTML. Interpolated user, client, resource, state, and error values pass through the dedicated HTML-escaping function before rendering.

## Security Best Practices

### For Developers

**1. Keep schemas and downstream boundaries explicit**
```typescript
inputSchema: z.object({
  city: z.enum(['dc', 'nyc']),
  query: z.string(),
})
```
Schema descriptions explain values to clients but do not create regex or length constraints. Encode URL components in the transit adapter that builds the relevant upstream request, and render user-influenced HTML only through the dedicated escaping path.

**2. Use TypeScript Strictly**
```typescript
// Enable in tsconfig.json
{
  "strict": true,
  "noUncheckedIndexedAccess": true
}
```

**3. Handle Errors and Telemetry Safely**

Preserve abort and MCP protocol errors at their existing boundaries, and use the shared tool-error mapping for uncaught operational failures. Application telemetry is structured and restricted to allowlisted fields. Never log raw error objects, tokens, secrets, or user payloads.

**4. Use Prepared Statements (if using SQL)**
```typescript
// We don't use SQL, but if we did:
db.query('SELECT * FROM stations WHERE id = ?', [stationId]);
// NOT: db.query(`SELECT * FROM stations WHERE id = '${stationId}'`);
```

**5. Review Exact Dependency Pins**
```bash
bun install --frozen-lockfile
bun audit
```

**6. Review Code for Security**
- Check each input has an accurate SDK schema and field-specific downstream boundary
- Verify authentication is required
- Verify any Cloudflare edge policy keys on authenticated or trusted identity
- Confirm security headers are set

**7. Test Security Features**
- Exercise the registered SDK wire schema rather than a duplicate validator.
- Test every documented enum, regex, range, or length limit at that wire boundary.
- Verify outbound URL construction and HTML escaping at their actual adapter/rendering boundaries.

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

**2. Monitor Edge Rate Policy**
- Review Cloudflare edge analytics separately from application telemetry
- Check for unusually high edge rejection rates
- Adjust configured edge rules if legitimate users are blocked
- Investigate patterns of abuse

**3. Review Logs Regularly**

Application telemetry may contain only `correlationId`, `era`, `protocolVersion`, `mcpMethod`, `mcpName`, `alias`, `clientId`, `upstream`, `durationMs`, and `statusClass`; invalid or unknown fields are dropped. Use `statusClass` and the safe request dimensions for application trends. Authentication detail and rate-limit analytics are not emitted by this telemetry and must be reviewed in the owning platform when available.

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

Structured telemetry is limited to allowlisted fields and reports only the response status class, not a raw response or error. Never log raw error objects, access or refresh tokens, authorization codes, GitHub tokens, secrets, raw Provider props, request bodies, user payloads, or MRTR responses. The conformance proxy binds only `127.0.0.1`, replaces inbound Authorization, supplies the operator token only from the process environment, uses manual redirects, and rejects remote targets unless `MCP_CONFORMANCE_ALLOW_REMOTE=1` is explicit.

### Incident Response

**If Security Issue Discovered:**

1. **Assess severity**: What data/systems are affected?
2. **Contain**: Can it be mitigated quickly?
3. **Fix**: Deploy patch
4. **Notify**: Inform affected users if needed
5. **Review**: How did it happen? How to prevent?

**If Abuse Detected:**

1. **Identify**: Which IPs/users?
2. **Block**: Add or update an approved Cloudflare edge rule if needed
3. **Investigate**: Automated or targeted attack?
4. **Adjust**: Update rate limits or validation rules

## Security Checklist

- [ ] Every tool input has an accurate SDK schema and documented downstream boundary
- [ ] Any edge rate policy uses authenticated or trusted source identity
- [ ] Authentication is required for MCP endpoints
- [ ] Production and preview origins use HTTPS; only loopback development may use HTTP
- [ ] Security headers are applied
- [ ] Secrets are stored in environment variables
- [ ] Exact dependency pins are reviewed and the frozen install passes
- [ ] Security tests pass
- [ ] No secrets in code/logs
- [ ] Public errors and structured telemetry are reviewed for sensitive-data disclosure
- [ ] Production and preview OAuth storage, apps, callbacks, and MRTR keys are distinct
- [ ] Rollback assets and the original `v1` migration remain intact

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP Secure Headers](https://owasp.org/www-project-secure-headers/)
- [OAuth 2.1](https://oauth.net/2.1/)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [Content Security Policy](https://content-security-policy.com/)
