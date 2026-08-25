# Metro MCP 6.0 Anonymous Public Service Design

**Date:** 2026-08-21
**Status:** Approved
**Owner:** Anurag Dhungana
**Target release:** 6.0.0

## Summary

Metro MCP 6.0 removes GitHub OAuth and every application authentication
boundary. The service exposes public, read-only DC Metro and NYC Subway data,
so identity, consent, scopes, token storage, refresh rotation, and legacy-token
compatibility add friction without protecting private data or privileged
actions.

The release routes anonymous MCP requests directly to the stateless MCP 2026
handler, retains the existing transport and input trust boundaries, replaces
identity-based abuse controls with Cloudflare edge rate limiting, and publishes
canonical privacy, terms, and support pages on the Metro MCP domain. This is a
hard cutover: active OAuth endpoints, discovery, code, dependencies, bindings,
secrets, tests, and documentation are removed rather than deprecated in place.

## Goals

- Let Claude, Codex, ChatGPT, and other compatible clients connect to Metro MCP
  without login, consent, registration, tokens, or scopes.
- Delete GitHub OAuth, the Cloudflare OAuth Provider, DCR/CIMD, refresh and
  revocation flows, and the legacy JWT bridge from the active repository.
- Preserve the exact 13-tool, 3-resource, 3-prompt MCP contract and Transit
  Board MCP App behavior.
- Preserve stateless MCP 2026, ordinary stateless MCP 2025 compatibility,
  request-scoped SSE responses, cancellation, progress, MRTR, cache hints, and
  the exact `/sse` POST alias.
- Preserve strict hostname, public-origin, browser-Origin, protocol metadata,
  schema, cancellation, and response security boundaries.
- Protect the anonymous public endpoint and WMATA quota with measured,
  testable Cloudflare edge rate limiting that does not rely on application
  identity.
- Publish accurate `/privacy/`, `/terms/`, and `/support/` pages on
  `metro-mcp.anuragd.me` and link them from the landing page and documentation.
- Produce directory-ready metadata and evidence for OpenAI and Anthropic.

## Non-goals

- Adding accounts, API keys, billing, paid tiers, write tools, private transit
  data, or user-specific preferences.
- Replacing the existing transit adapters, schemas, Apps UI, or cache policy.
- Removing the inactive `MetroMcpAgent` rollback class or the original Durable
  Object migration.
- Adding an application database, analytics product, fingerprinting, cookies,
  or browser storage.
- Claiming an exact third-party log-retention period that the repository cannot
  enforce.
- Building the OpenAI or Claude directory package in this release. Version 6.0
  makes the server submission-ready; packaging and submission follow separately.

## User decisions

The following decisions are final for this design:

1. Metro MCP 6.0 is a hard anonymous cutover, not a compatibility window.
2. OAuth is deleted completely from the active code and deployment contract.
3. Cloudflare edge rate limiting is a production launch requirement.
4. Privacy, terms, and support pages live on the Metro MCP domain.
5. The release is versioned as 6.0.0 because the connection contract changes.

## Public request architecture

### Request flow

For an MCP request, the Worker processes boundaries in this order:

1. Normalize only exact supported MCP paths and methods. Exact `POST` and
   `OPTIONS` requests to `/sse` normalize to `/mcp`; unsupported methods,
   slash variants, and session-like subpaths keep their current deterministic
   `405` behavior.
2. Require the request URL origin to equal configured `MCP_PUBLIC_ORIGIN`.
3. Validate `Host` against `MCP_ALLOWED_HOSTNAMES` and a browser `Origin`, when
   present, against `MCP_ALLOWED_ORIGIN_HOSTNAMES`. Origin-less desktop and
   server clients remain valid.
4. Remove the `Authorization` header before SDK dispatch. The header is neither
   validated nor logged. This lets clients with stale cached credentials keep
   working without preserving an authentication boundary.
5. Apply the Cloudflare anonymous MCP rate limiter.
6. Enforce the existing modern protocol-header/body agreement and legacy
   request classifier behavior.
7. Create a fresh request-scoped MCP server and dispatch directly through the
   SDK v2 handler.
8. Preserve the existing cancellation bridge, security-header composition,
   request ID, and allowlisted telemetry.

The Worker does not construct an OAuth Provider and does not synthesize a fake
user, client, scope, or authorization object.

### Route contract

| Route | Method | Metro MCP 6.0 behavior |
| --- | --- | --- |
| `/mcp` | `POST`, `OPTIONS` | Anonymous stateless MCP |
| `/sse` | `POST`, `OPTIONS` | Exact alias normalized to `/mcp` |
| `/mcp`, `/sse` | `GET`, `DELETE` | `405`, preserving the current Allow contract |
| `/mcp/`, `/sse/`, session subpaths | any | Existing deterministic rejection |
| `/info` | `GET` | Public 6.0 metadata with `authentication.type = "none"` |
| `/privacy/`, `/terms/`, `/support/` | `GET` | Static Metro MCP pages |
| `/authorize`, `/callback`, `/authorize/decision` | any | Ordinary `404` |
| `/token`, `/register` | any | Ordinary `404` |
| OAuth `.well-known` routes | any | Ordinary `404` |
| Other public assets | `GET` | Existing asset binding behavior |

No active response includes `WWW-Authenticate`, OAuth scopes, authorization
server metadata, token endpoints, or registration endpoints.

## Anonymous MCP context

`MetroMcpProps`, `AuthInfo`, `parseMetroMcpProps`, and `requireTransitRead` are
removed. The request-scoped MCP context contains only information required by
the product:

- Worker environment and transit bindings
- protocol era (`modern` or `legacy`)
- the existing test-only dependency injection seam

Tools, resources, prompts, and Apps do not depend on identity today, so their
wire schemas and output behavior remain unchanged.

Telemetry no longer records an OAuth client ID. The allowlist continues to
permit only correlation ID, protocol era and version, MCP method and name,
route alias, upstream label, duration, and status class. Authorization headers,
request bodies, tool arguments, station queries, and upstream response bodies
must never enter Metro telemetry.

## Signed MRTR request state

`MCP_REQUEST_STATE_KEY` remains a required, independent 32-byte-or-longer
secret. Modern ambiguous-station MRTR still uses a signed five-minute state
containing the phase, tool name, city, normalized query, and offered candidate
IDs.

The signature binds to the MCP method. It no longer binds to a user ID because
there is no identity. The state still rejects:

- expiration
- signature tampering
- use with a different MCP method or tool
- changed city or query
- a station ID outside the signed candidate list
- malformed response shapes

Signed state is client-held, contains public transit choices rather than
secrets, and creates no server-side session. Cross-user replay is no longer
described as a security boundary; possession of a valid unexpired state can
only select one of the public candidates already embedded in that state.

## Rate limiting and abuse controls

### Cloudflare binding

Production and preview receive distinct Cloudflare Workers Rate Limiting
bindings and namespace IDs. The Worker calls the binding only after MCP path,
method, host, and origin validation and before parsing or dispatching the MCP
body. Static assets, `/info`, legal pages, and `OPTIONS` do not consume the MCP
request allowance.

Anonymous traffic has no durable user identifier. The limiter therefore uses
the Cloudflare-provided connecting IP as the least-bad stable actor signal and
documents the shared-egress limitation. It must not key on `Mcp-Method`,
`Mcp-Name`, User-Agent, or any client-supplied identity as if those values were
trusted.

The production threshold is not guessed in advance. It is selected and
committed after preview measurement using:

- the complete frozen MCP conformance suite
- three consecutive Codex connection and DC/NYC call bursts
- three consecutive Claude connection and DC/NYC call bursts
- the browser Apps acceptance suite
- the observed maximum valid one-minute request burst with at least 10x
  headroom
- the effective WMATA account quota and existing cache fan-out

If the WMATA quota cannot be verified, the initial ceiling must be conservative
for the upstream but no lower than 300 accepted MCP POSTs per IP per minute.
Preview and production thresholds and namespace IDs are explicit in Wrangler
configuration and covered by config tests.

### Rejection contract

When the binding denies a request, the Worker returns HTTP `429` with:

- `Content-Type: application/json`
- `Retry-After: 60`
- the normal `X-Request-ID`
- JSON-RPC 2.0 error code `-32029`
- message `Rate limit exceeded`
- `id: null`, because the body is not parsed before rejection

The response receives the normal MCP JSON security headers. Telemetry records
only the request ID, route alias, duration, and `4xx` status class.

Cloudflare's built-in DDoS protection and operator WAF policy remain separate
layers. The rate-limit binding is permissive and eventually consistent, so it
is an abuse guard rather than an accounting or billing mechanism.

## OAuth deletion inventory

### Runtime and dependencies

Delete:

- `src/oauth/github-handler.ts`
- `src/oauth/provider.ts`
- `src/oauth/legacy-token.ts`
- OAuth route composition in `src/index.ts` and `src/public-handler.ts`
- OAuth types, Provider helpers, KV bindings, user records, and token fields in
  `src/types.ts`
- OAuth, legacy JWT, scope, and client identity configuration in `src/config.ts`
- `@cloudflare/workers-oauth-provider` from `package.json` and `bun.lock`
- unused OAuth-only imports from the MCP handler and context

The inactive Durable Object rollback class, original migration, Assets binding,
and current SDK v2 runtime dependencies remain unless a separate evidence-based
cleanup proves one unused.

### Deployment configuration

Remove from production, preview, examples, local templates, and tests:

- `OAUTH_KV`
- `OAUTH_PROVIDER`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `OAUTH_REDIRECT_URI`
- `JWT_SECRET`
- OAuth access, refresh, registration, and legacy-cutoff constants

Retain:

- `MCP_PUBLIC_ORIGIN`
- `MCP_ALLOWED_HOSTNAMES`
- `MCP_ALLOWED_ORIGIN_HOSTNAMES`
- `MCP_REQUEST_STATE_KEY`
- `WMATA_API_KEY`
- `ENVIRONMENT`
- `ASSETS`
- existing observability and rollback migration
- the new environment-specific anonymous MCP rate-limit binding

### Tests and scripts

Delete OAuth-only unit and Workerd suites rather than keeping dead behavior as
characterization. Replace them with anonymous request, negative route, metadata,
configuration, and edge rate-limit coverage.

Remove the bearer-token acquisition and authentication proxy from conformance.
The conformance runner targets `/mcp` directly and does not read, prompt for,
forward, or redact a token. Remove OAuth login instructions and token lifecycle
claims from all active documentation.

## Server and client metadata

`SERVER_VERSION` and `package.json` become `6.0.0`. The MCP protocol remains
`2026-07-28`.

`GET /info` must:

- use the canonical repository `https://github.com/Aarekaz/metro-mcp`
- link documentation to `https://metro-mcp.anuragd.me/docs/`
- link privacy, terms, and support to the canonical Metro MCP pages
- advertise only `/mcp` and the `/sse` compatibility alias
- omit OAuth endpoints and discovery
- report `authentication: { type: "none" }`
- preserve the 13/3/3 capability counts and no-server-push contract

Landing-page and documentation connection instructions remove login, scopes,
OAuth registration, token, and consent steps. Codex, Claude, and generic MCP
examples use only the remote MCP URL.

## Privacy, terms, and support pages

All three pages are static, scriptless, responsive documents in the existing
Metro MCP visual language. They use canonical URLs, descriptive titles, a
shared minimal navigation/footer, and reciprocal links. The landing page and
documentation footer link all three pages.

### Privacy

The privacy page accurately states:

- Metro MCP does not require accounts and does not intentionally collect
  GitHub identity, OAuth grants, access tokens, refresh tokens, client
  registrations, cookies, or browser storage in 6.0.
- The Worker processes MCP request bodies and public transit arguments only to
  answer the request.
- Cloudflare necessarily processes network metadata such as IP address, and
  sampled Worker logs/traces contain only the repository's allowlisted Metro
  telemetry fields. The page does not promise a retention period the Worker
  cannot enforce.
- WMATA and MTA receive server-to-server requests from the Worker; Metro MCP
  does not forward the user's IP address or conversation.
- A client-held signed MRTR state can persist for up to five minutes and
  contains only the public station-selection fields described above.
- Data is not sold and is not used for advertising or model training by the
  Metro MCP operator.
- Third-party processing is subject to Cloudflare, GitHub hosting, WMATA, MTA,
  and the user's MCP client policies as applicable.
- Users can stop processing by disconnecting or ceasing requests.
- The effective date and public support/security channels are visible.

The page must distinguish Metro MCP's practices from the independent policies
of Claude, OpenAI, Codex, or other clients.

### Terms

The terms page states that Metro MCP is an unofficial community project, is not
affiliated with or endorsed by WMATA, MTA, OpenAI, Anthropic, or transit
agencies, and provides public read-only transit information. It covers:

- fair use and prohibition of abuse, disruption, circumvention, or unlawful use
- no emergency, safety-critical, or guaranteed-arrival reliance
- possible delay, omission, inaccuracy, or unavailability of transit data
- third-party service and data-source terms
- the repository's MIT software license and preservation of its existing
  copyright notice
- service changes or discontinuation
- no warranty and a reasonable limitation-of-liability statement without
  inventing a jurisdiction or claiming legal advice

### Support

The support page provides:

- public documentation
- `GET /info` for server metadata and operational response
- GitHub Issues for reproducible non-sensitive bugs and feature requests
- GitHub's private vulnerability-reporting or Security Advisory flow for
  sensitive security reports, after verifying that the repository has enabled it
- a checklist of version, client, request ID, timestamp, city/tool, and minimal
  reproduction details to include without credentials or private conversation
  content
- an explicit instruction never to post API keys, bearer tokens, or secrets

No personal email address is published without a separate owner decision.

## Security documentation

`docs/SECURITY.md` is rewritten only where the active boundary changes. It must
remove GitHub OAuth, Provider diagnostics, DCR, PKCE, scope, token, consent,
legacy JWT, OAuth callback HTML, and OAuth-specific log claims. It must retain
and accurately describe:

- public-origin, Host, and browser-Origin validation
- anonymous rate limiting and its shared-IP limitation
- protocol metadata and route normalization
- signed MRTR state without user binding
- active schema, upstream, cancellation, response, and Apps boundaries
- Metro telemetry allowlisting and sensitive Cloudflare log access
- secret handling for only the remaining request-state and WMATA keys

## Testing strategy

Implementation follows strict red-green TDD. Tests assert observable behavior,
not deleted implementation details.

### Unit and configuration

- anonymous MCP dispatch succeeds without props or AuthInfo
- supplied Authorization headers are absent at SDK dispatch and telemetry
- old OAuth and discovery routes are 404
- unsupported MCP routes and methods preserve exact behavior
- `/info` is 6.0, anonymous, canonical, and contains legal/support links
- MRTR completion, tampering, expiry, method/tool/query/candidate mismatch, and
  request-state key length remain locked
- production, preview, example, and local configuration contain no OAuth or JWT
  binding/variable and have distinct rate-limit namespaces
- legal pages exist, are canonical, contain required disclosures, and have no
  scripts, forms, trackers, or external runtime resources
- landing/docs footers link all legal pages
- dependency and lockfile scans contain no OAuth Provider package

### Workerd

- unauthenticated modern `server/discover` and exact 13/3/3 listing
- representative DC and NYC tool calls, resources, prompts, Apps, progress,
  cancellation, MRTR, cache hints, and 2025 compatibility
- no RFC 9728 challenge or `WWW-Authenticate`
- bearer/query token inputs do not create an authentication path
- Host, origin, scheme, protocol-version, route, and method rejection
- deterministic allow/deny behavior through a test rate-limit binding
- `429` JSON-RPC body, headers, security composition, and telemetry redaction

### Browser and static pages

- existing 51-scenario managed-Chromium Apps acceptance remains green
- privacy, terms, support, landing, and docs render at desktop and 320px without
  horizontal overflow
- keyboard navigation, headings, landmarks, visible focus, link targets, and
  color contrast receive a browser smoke test
- no console errors, network trackers, storage access, permissions, or scripts
  on legal pages

### Full gates

- frozen Bun install without lock drift
- every TypeScript project
- full unit and Workerd suites
- combined test command
- deterministic Apps build twice with identical hash
- three consecutive managed-Chromium runs with zero retries
- production and preview Wrangler dry-runs
- direct anonymous frozen MCP conformance
- source, bundle, binding, secret-name, OAuth-route, dependency, and diff scans
- independent implementation review and security-diff review with no unresolved
  Critical, Important, or Minor findings

## Preview and production acceptance

### Preview

1. Deploy preview code and its distinct rate-limit namespace.
2. Confirm public metadata and legal/support pages.
3. Run direct anonymous conformance without a token proxy.
4. Connect fresh Codex and Claude entries using only the preview `/mcp` URL.
5. Verify exact discovery, one live DC call, one live NYC call, a resource,
   prompt, MCP App, progress, cancellation, and modern MRTR.
6. Run the measured burst matrix, choose the production threshold with the
   specified headroom, and verify a controlled preview `429` without affecting
   unrelated public pages.
7. Inspect private logs for request IDs and status only; confirm that supplied
   canary bearer values and request arguments never appear.

### Production

1. Merge the reviewed branch and deploy the same verified artifact and
   production rate-limit namespace.
2. Repeat anonymous server discovery, 13/3/3, DC, NYC, resource, prompt, App,
   MRTR, route, legal/support, security-header, and no-challenge checks.
3. Connect fresh production Codex and Claude entries without login.
4. Verify prior client configurations that still send a bearer header continue
   to work and the canary value is not logged.
5. Confirm rate-limit telemetry without intentionally exhausting the production
   allowance.
6. Record the deployed Worker version, artifact hash, test counts, response
   evidence, and exact remaining configuration names without secret values.

## Cleanup and rollback

The active service becomes anonymous at deployment. Irreversible external
cleanup happens only after production acceptance and an ownership check:

- delete obsolete production and preview Worker secrets
- remove unused OAuth KV namespace bindings from the deployment first
- verify the exact KV namespace IDs are dedicated to Metro OAuth, then delete
  the namespaces
- verify the exact GitHub OAuth App IDs are dedicated to Metro production,
  preview, and local development, then delete the apps

Before deleting KV namespaces or GitHub OAuth Apps, capture names and IDs only,
confirm no other Worker/repository references them, and request final owner
confirmation because those operations are irreversible. Never print secret
values.

Cloudflare deployment rollback remains available during acceptance. A rollback
to 5.0 after external OAuth cleanup would require restoring the removed
bindings, secrets, and GitHub apps; therefore irreversible cleanup is not part
of the initial deployment transaction.

## Release and submission evidence

The release notes state:

- **Breaking:** Metro MCP is now anonymous and no longer exposes OAuth.
- Remove saved Metro MCP credentials if the client continues presenting them;
  reconnecting requires only the server URL.
- All tools remain public, read-only, and live-data/open-world.
- Version 6.0 adds canonical privacy, terms, and support pages and anonymous
  abuse controls.

Directory evidence includes the public MCP URL, `/info`, documentation,
privacy, terms, support, exact tool annotations, 13/3/3 inventory, Apps
screenshots, test prompts, anonymous connection instructions, rate-limit
behavior, and production acceptance results.

## Acceptance criteria

Metro MCP 6.0 is complete only when:

1. No active source, bundle, dependency, binding, configuration, test helper,
   or operator instruction implements or requires OAuth, GitHub identity,
   scopes, access/refresh tokens, DCR/CIMD, or legacy JWTs.
2. Anonymous modern and legacy MCP behavior passes local, Workerd, conformance,
   preview, production, Codex, and Claude acceptance.
3. All prior non-authentication MCP, Apps, transit, cancellation, caching,
   routing, trust-boundary, and security contracts remain green.
4. The Cloudflare rate limiter is configured distinctly for preview and
   production, calibrated from measured legitimate traffic, and verified at
   its preview boundary.
5. `/privacy/`, `/terms/`, and `/support/` are public, accurate, responsive,
   linked, and suitable for OpenAI and Anthropic directory submission.
6. Production `/info` reports version 6.0.0, authentication `none`, canonical
   Aarekaz repository/docs/legal URLs, and no OAuth endpoints.
7. Independent code and security reviews approve the final diff with no
   unresolved findings.
8. External destructive cleanup occurs only after production acceptance,
   ownership checks, and final owner confirmation.
