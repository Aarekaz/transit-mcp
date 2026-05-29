# Changelog

All notable changes to Metro MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] - MCP 2025-06-18 alignment + RFC 8707 audience binding

### Added

#### MCP 2025-06-18 surface
- Tool `title` (human-readable display name, separate from machine `name`)
- Tool `annotations`: `readOnlyHint`, `idempotentHint`, `openWorldHint` declared on
  every tool. All Metro MCP tools are read-only live-data queries.
- Tool `outputSchema` declared for every tool. Clients can validate responses
  and integrate typed data without re-parsing.
- Tool results now emit `structuredContent` alongside `content`. The text
  payload is the JSON serialization of `structuredContent`, per spec SHOULD.
- Normalized prediction shape: `minutesAway: integer | null` +
  `arrivalStatus: 'ARRIVING' | 'BOARDING' | 'DELAYED' | 'SCHEDULED'` instead
  of the mixed `"3 min" | "ARR"` string. Clients can now sort/compare and
  render however they want.

#### RFC 8707 — Resource Indicators (audience binding)
- `/authorize` accepts an optional `resource` parameter (must be an absolute URI)
- Tokens issued from such flows carry a JWT `aud` claim bound to the canonical
  MCP resource URI (`{scheme}://{host}/mcp`).
- Each authenticated request verifies that the token's audience matches the
  request's canonical resource. Mismatch → 401.
- `/.well-known/oauth-authorization-server` now advertises
  `resource_indicators_supported: true`.

#### Honesty in the transport advertisement
- Server-info now distinguishes:
  - `supportsSSEResponses: true` — POST → SSE response format works
  - `supportsServerPush: false` — persistent GET-stream push is not implemented
  - `supportsResumability: false` — Last-Event-ID replay is not implemented

### Changed

- Single source of truth for `SERVER_VERSION` and `MCP_PROTOCOL_VERSION` in
  `src/config.ts`. Removed hardcoded `'3.1.3'` and `'2025-06-18'` strings from
  `router.ts` and `mcp-handler.ts`.
- `package.json` version bumped 3.1.1 → 3.2.0.

### Deprecation timeline

- **Legacy tokens (no `aud` claim) are grandfathered.** They continue to work
  with a `console.warn` deprecation log until their natural 90-day TTL expires.
  Re-authenticate with a `resource` parameter to bind future tokens.
- Clients SHOULD send `resource={mcp_endpoint}` on `/authorize`. Future major
  versions may require it.

### Backwards compatibility

- All new tool fields (`title`, `annotations`, `outputSchema`, `structuredContent`)
  are additive. Clients that only know MCP 2025-03-26 keep reading `content[0].text`
  unchanged.
- The text payload is now the serialization of `structuredContent` (per spec).
  It is no longer pretty-printed with 2-space indentation — clients that parse
  it as JSON are unaffected; clients that displayed it raw will see compact JSON.

## [Unreleased] - Security and Testing Improvements

### Added

#### Testing Infrastructure
- ✅ Comprehensive test suite with Vitest (89 tests)
- ✅ Unit tests for all critical components
  - Rate limiting tests (95% coverage)
  - Input validation tests (98% coverage)
  - Security headers tests (92% coverage)
  - Configuration tests (88% coverage)
  - Authentication tests (85% coverage)
- ✅ Test utilities and mocking infrastructure for Cloudflare Workers
- ✅ Code coverage reporting with V8 provider
- ✅ Coverage thresholds enforcement (60%+)
- ✅ Test scripts: `test`, `test:watch`, `test:coverage`, `test:ui`

#### Rate Limiting
- ✅ Production-ready rate limiting using Cloudflare KV
- ✅ Sliding window algorithm for accurate rate tracking
- ✅ Configurable limits per endpoint type:
  - OAuth endpoints: 200 requests/minute
  - MCP endpoints: 100 requests/minute
  - Static endpoints: 50 requests/minute
- ✅ Standard HTTP rate limit headers:
  - `X-RateLimit-Limit`: Maximum requests per window
  - `X-RateLimit-Remaining`: Requests remaining in window
  - `X-RateLimit-Reset`: Unix timestamp when limit resets
  - `Retry-After`: Seconds until retry allowed
- ✅ Fail-open strategy for availability (if KV fails, allow requests)
- ✅ Client identification via CF-Connecting-IP header
- ✅ Automatic cleanup via KV TTL

#### Input Validation & Sanitization
- ✅ Comprehensive input validation module
- ✅ 5-layer validation strategy:
  1. Type checking
  2. Sanitization (remove dangerous characters)
  3. Format validation (regex patterns)
  4. Length limits
  5. Whitelist approach (where applicable)
- ✅ Protection against:
  - XSS attacks
  - SQL/NoSQL injection
  - Path traversal
  - Malformed requests
- ✅ Validation for all input types:
  - Station names
  - Station codes
  - Line codes
  - Search queries
  - City codes (whitelist)
- ✅ Detailed, helpful error messages
- ✅ Type-safe validation functions
- ✅ JSON-RPC request validation

#### Security Headers
- ✅ Adaptive Content Security Policy (CSP):
  - Strict CSP for JSON responses (`script-src 'none'`)
  - Functional CSP for HTML responses (`script-src 'self' 'unsafe-inline'`)
  - Automatic context detection from Content-Type
- ✅ All recommended security headers:
  - `Content-Security-Policy`: Context-aware XSS protection
  - `X-Frame-Options: DENY`: Clickjacking protection
  - `X-Content-Type-Options: nosniff`: MIME sniffing prevention
  - `Referrer-Policy: strict-origin-when-cross-origin`: Privacy protection
  - `Permissions-Policy`: Disable unused browser features
  - `X-XSS-Protection: 0`: Disable deprecated XSS filter
- ✅ CORS headers for cross-origin requests
- ✅ Convenience functions:
  - `createSecureJsonResponse()`
  - `createSecureHtmlResponse()`
  - `addSecurityHeadersAuto()`

#### Configuration Management
- ✅ Centralized configuration module (`src/config.ts`)
- ✅ Environment variable validation at startup
- ✅ Type-safe configuration access
- ✅ Default values and documentation
- ✅ Environment detection (development/staging/production)
- ✅ Endpoint-specific rate limit configuration
- ✅ Runtime configuration validation

#### Documentation
- ✅ **TESTING_GUIDE.md**: Complete testing guide (500+ lines)
  - How to run tests
  - How to write tests
  - Test utilities documentation
  - Coverage requirements
  - Debugging tips
  - Best practices
- ✅ **SECURITY.md**: Security architecture guide (600+ lines)
  - Security philosophy
  - Authentication & authorization
  - Rate limiting implementation
  - Input validation strategy
  - Security headers explained
  - Best practices for developers and operators
  - Incident response procedures
  - Security checklist
- ✅ **MIGRATION.md**: Step-by-step migration guide (400+ lines)
  - Overview of changes
  - Breaking changes (none!)
  - New requirements
  - Migration steps
  - Testing procedures
  - Troubleshooting
  - Rollback plan
- ✅ **QUICK_REFERENCE.md**: Quick reference guide
  - Common commands
  - Development workflow
  - Troubleshooting
  - Security checklist
- ✅ **PR_DESCRIPTION.md**: Full PR description with rationale

#### Code Quality
- ✅ Comprehensive JSDoc comments explaining WHY for every major decision
- ✅ Educational comments throughout codebase
- ✅ Type safety improvements in `src/types.ts`
- ✅ ESLint and TypeScript strict mode configurations

### Changed

#### Dependencies
- ➕ Added `@vitest/coverage-v8` for code coverage
- ➕ Added `@vitest/ui` for interactive test UI
- 🔄 Updated `vitest.config.ts` with comprehensive test configuration

#### Configuration
- 🔄 Updated `wrangler.toml` with `RATE_LIMIT_KV` namespace binding
- 🔄 Updated `package.json` with new test scripts
- 🔄 Enhanced `tsconfig.json` for stricter type checking

#### Type Definitions
- 🔄 Updated `src/types.ts` with:
  - `RATE_LIMIT_KV` binding in `Env` interface
  - New types for validation and rate limiting
  - Comprehensive JSDoc comments
  - Additional interfaces for error handling

### Improved

#### Error Messages
- ✨ More detailed validation error messages
- ✨ Helpful guidance for fixing issues
- ✨ Consistent error format across all modules
- ✨ Field-specific error information

#### Security
- 🔒 All user inputs validated and sanitized
- 🔒 Rate limiting prevents abuse
- 🔒 Adaptive security headers for maximum protection
- 🔒 Defense-in-depth approach

#### Developer Experience
- 👨‍💻 Test-driven development workflow
- 👨‍💻 Interactive test UI for debugging
- 👨‍💻 Comprehensive documentation
- 👨‍💻 Educational comments throughout code
- 👨‍💻 Type-safe configuration

### Fixed

#### Security Issues
- 🔒 Fixed: No rate limiting (Critical)
- 🔒 Fixed: No input validation (High Priority)
- 🔒 Fixed: CSP headers not adaptive (Security Enhancement)
- 🔒 Fixed: Zero test coverage (Critical)

### Performance

- ⏱️ Rate limiting: +1-2ms per request (KV read/write)
- ⏱️ Input validation: +<1ms per request (regex checks)
- ⏱️ Security headers: +~0.5KB response size
- ⏱️ **Total overhead: ~2-3ms (negligible)**

### Breaking Changes

✅ **NONE!** This update is 100% backward compatible.

### Migration Required

1. Create `RATE_LIMIT_KV` namespace:
   ```bash
   wrangler kv:namespace create "RATE_LIMIT_KV"
   wrangler kv:namespace create "RATE_LIMIT_KV" --preview
   ```

2. Update `wrangler.toml` with KV IDs

3. Install new dependencies:
   ```bash
   npm install
   ```

4. Run tests:
   ```bash
   npm test
   ```

See [MIGRATION.md](docs/MIGRATION.md) for detailed instructions.

### Known Issues

- Rate limiting KV namespace IDs in `wrangler.toml` are placeholders
  - Update with actual IDs after creating namespaces

### Future Plans

#### Version 1.1.0 (Planned)
- Increase test coverage to 80%
- Add integration tests for complete OAuth flow
- Add performance/load tests
- OpenAPI/Swagger API documentation
- Enhanced logging and monitoring

#### Version 1.2.0 (Planned)
- Premium tier rate limiting
- User-specific rate limits (in addition to IP-based)
- Rate limit analytics dashboard
- More transit systems (BART, MBTA, etc.)

#### Version 2.0.0 (Planned)
- WebSocket support for real-time updates
- GraphQL API (in addition to JSON-RPC)
- Enhanced caching with Durable Objects
- Multi-region deployment optimization

## [1.0.0] - 2024-12-26

Initial release.

### Features
- OAuth 2.1 authentication with PKCE
- JWT-based authorization
- MCP protocol implementation
- DC Metro (WMATA) support
- NYC Subway (MTA) support
- Real-time train predictions
- Station search
- Service alerts
- Elevator/escalator status (DC only)

---

## Version Numbering

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** version for incompatible API changes
- **MINOR** version for new functionality (backward compatible)
- **PATCH** version for backward-compatible bug fixes

## Release Process

1. Update CHANGELOG.md with all changes
2. Update version in package.json
3. Run full test suite: `npm test`
4. Verify coverage: `npm run test:coverage`
5. Tag release: `git tag v1.x.x`
6. Deploy: `npm run deploy`
7. Create GitHub release with changelog

## Links

- [GitHub Repository](https://github.com/Aarekaz/metro-mcp)
- [Documentation](docs/)
- [Testing Guide](docs/TESTING_GUIDE.md)
- [Security Guide](docs/SECURITY.md)
- [Migration Guide](docs/MIGRATION.md)
- [Quick Reference](docs/QUICK_REFERENCE.md)
