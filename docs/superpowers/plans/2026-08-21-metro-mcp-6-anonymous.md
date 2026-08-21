# Metro MCP 6.0 Anonymous Public Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Metro MCP 6.0 over from GitHub OAuth to a public, anonymous, read-only MCP service, protect it with Cloudflare rate limiting, publish accurate legal/support pages, and verify preview and production before deleting the retired OAuth infrastructure.

**Architecture:** The Worker validates the canonical request origin, Host, optional browser Origin, MCP route, and protocol metadata before sending anonymous requests directly to the stateless MCP handler. A Cloudflare Workers Rate Limiting binding gates accepted MCP `POST` traffic by trusted edge IP, while MCP request state remains signed and bound to the method rather than a user. Static, scriptless privacy, terms, and support pages are served by the existing Assets binding. The inactive Durable Object rollback class and original migration remain untouched.

**Tech Stack:** Bun 1.3.14, TypeScript 5.6, Cloudflare Workers/Wrangler 4.122, MCP Server 2.0.0, Agents 0.20.1, Vitest 4.1.10, Cloudflare Workers Vitest Pool 0.16.20, Playwright 1.62.1, Vite 8.2.1.

**Spec:** `docs/superpowers/specs/2026-08-21-metro-mcp-6-anonymous-design.md`

## Global Constraints

- Work only in the isolated `feat/metro-mcp-6-anonymous` worktree. The user's main checkout contains unrelated changes and must remain untouched.
- Use strict RED-GREEN-REFACTOR for every behavior change. Record the failing assertion and command before changing production code.
- Preserve the exact 13-tool, 3-resource, 3-prompt catalog, Transit Board App, MCP 2026 stateless transport, MCP 2025 stateless compatibility, `/sse` POST alias, progress, cancellation, MRTR, and cache contracts.
- Preserve exact-origin, Host, optional browser-Origin, route, method, protocol metadata, schema, upstream URL, output, and telemetry safety boundaries.
- Strip and ignore an incoming `Authorization` header. Do not use it for identity, rate-limit keys, logs, or authorization.
- Keep `MCP_REQUEST_STATE_KEY`; bind signed MRTR state to public request data, never to a user identity.
- Keep `src/mcp-agent.ts`, the `MetroMcpAgent` export, `@modelcontextprotocol/sdk` 1.x, and the original Durable Object migration unchanged for rollback.
- Remove OAuth from active source, configuration, deployment bindings, tests, docs, and dependencies. Historical changelog entries may continue to describe older releases.
- Rate-limit only normalized, trusted MCP `POST` requests. Do not count `OPTIONS`, assets, `/info`, or legal/support pages.
- Use distinct production and preview rate-limit namespaces. Preview calibration must happen before production deployment.
- Never print or commit secret values. Secret inspection reports names/status only.
- Do not delete deployed secrets, OAuth KV namespaces, or GitHub OAuth Apps until the exact merged production commit passes live acceptance and the owner gives a final explicit confirmation.
- Before each commit, inspect `git diff --check`, the scoped diff, staged filenames, and `git diff --cached`. Verify commit author is `Anurag Dhungana <36888347+Aarekaz@users.noreply.github.com>`.
- Each task report goes in `.superpowers/sdd/2026-08-21-metro-mcp-6-anonymous/`, ends with `DONE`, and truthfully distinguishes automated, local-live, preview-live, production-live, and pending evidence.

---

## Task 1: Route anonymous MCP requests directly to the stateless server

**Files:**

- Modify: `src/index.ts:1-106`
- Modify: `src/public-handler.ts:1-55`
- Modify: `src/mcp/context.ts:1-68`
- Modify: `src/mcp/http-handler.ts:1-151`
- Modify: `src/mcp/server.ts:1-91`
- Modify: `src/telemetry.ts:1-80`
- Modify: `tests/setup.ts`
- Modify: `tests/unit/index-routing.test.ts`
- Replace: `tests/unit/entry-provider-composition.test.ts` with `tests/unit/entry-anonymous-composition.test.ts`
- Modify: `tests/unit/public-routing.test.ts`
- Modify: `tests/unit/mcp-context.test.ts`
- Modify: `tests/unit/mcp-http-handler.test.ts`
- Modify: `tests/unit/mcp-http-cancellation.test.ts`
- Modify: `tests/unit/mcp-server.test.ts`
- Modify: `tests/unit/mcp-stations.test.ts`
- Modify: `tests/unit/telemetry.test.ts`
- Modify: `tests/workers/mcp-worker.test.ts`
- Delete: `tests/workers/oauth-worker.test.ts`

**Interfaces consumed:** `normalizeMcpRoute(request)`, `hostHeaderValidationResponse`, `originValidationResponse`, `createMcpHandler`, `createMetroMcpServer`, `loadConfig`, the existing cancellation bridge, and the existing Assets binding.

**Interfaces produced:**

```ts
export interface MetroMcpContext {
  env: Env;
  era: 'modern' | 'legacy';
  deps?: Partial<RequestDeps>;
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  config: Config = loadConfig(env),
  telemetry?: TelemetryInput,
): Promise<Response>
```

- [ ] Add failing unit and Workerd assertions that an anonymous MCP 2026 `server/discover` reaches the real server without `WWW-Authenticate`, Provider props, `AuthInfo`, or an initialization step.

```ts
const response = await worker.fetch(modernRequest('server/discover'), env, ctx);
expect(response.status).toBe(200);
expect(response.headers.has('WWW-Authenticate')).toBe(false);
expect(await response.json()).toMatchObject({ result: { serverInfo: { name: 'metro-mcp' } } });
```

- [ ] Add failing assertions that a stale `Authorization: Bearer canary-do-not-log` header is removed before `createMcpHandler`, does not change the response, and does not appear in serialized telemetry.

- [ ] Add failing assertions that `/authorize`, `/authorize/decision`, `/callback`, `/token`, `/register`, `/.well-known/oauth-authorization-server`, and every protected-resource discovery variant return `404` through both unit routing and Workerd.

- [ ] Add failing trust-boundary assertions for production and preview: noncanonical scheme, authority/Host disagreement, invalid Host, invalid browser Origin, normalized `/sse`, origin-less desktop clients, `OPTIONS`, and unsupported slash/session paths.

- [ ] Add a failing MRTR assertion proving a signed station-selection `requestState` verifies when retried for the same MCP method and rejects when replayed against a different method, without any user props in the state binding.

- [ ] Run the RED slice and capture the expected failures:

```bash
bunx vitest run --config vitest.config.ts \
  tests/unit/index-routing.test.ts \
  tests/unit/entry-anonymous-composition.test.ts \
  tests/unit/public-routing.test.ts \
  tests/unit/mcp-context.test.ts \
  tests/unit/mcp-http-handler.test.ts \
  tests/unit/mcp-server.test.ts \
  tests/unit/telemetry.test.ts
bunx vitest run --config vitest.workers.config.ts tests/workers/mcp-worker.test.ts
```

- [ ] Simplify `MetroMcpContext` to `env`, `era`, and optional request dependencies. Delete `MetroMcpProps`, `parseMetroMcpProps`, `requireTransitRead`, OAuth errors, scopes, user fields, and `AuthInfo` from active MCP code.

- [ ] Change the request-state codec binding in `src/mcp/server.ts` to the exact MCP method only:

```ts
const stateCodec = createRequestStateCodec<MetroRequestState>({
  key: context.env.MCP_REQUEST_STATE_KEY,
  ttlSeconds: 300,
  bind: serverContext => serverContext.mcpReq.method,
});
```

- [ ] Change `handleMcpRequest` to preserve modern-header enforcement and cancellation, clone the request with `Authorization` deleted, and call the SDK handler without `authContext`, Provider props, or `AuthInfo`:

```ts
const headers = new Headers(request.headers);
headers.delete('Authorization');
const anonymousRequest = new Request(request, { headers });
const linked = linkMcpRequestSignal(anonymousRequest);
const response = await handler.fetch(linked.request);
```

- [ ] Replace Provider dispatch in `src/index.ts` with direct `handleMcpRequest(normalized.request, env, config, telemetry)` after exact-origin, Host, and optional browser-Origin validation. Remove OAuth route classification so former OAuth routes fall through to public asset routing and return `404`.

- [ ] Remove OAuth handlers from `src/public-handler.ts`; retain `/info`, ordinary assets, GET-only static routing, and deterministic `404` for unmatched writes.

- [ ] Remove `clientId` from `TelemetryInput`, `SafeTelemetry`, sanitizer output, and tests.

- [ ] Run the GREEN slices, then the entire automated baseline:

```bash
bun run type-check
bun run test:unit
bun run test:workers
bun run test
```

- [ ] Self-review against the spec. Search active runtime/test code for accidental `AuthInfo`, `authContext`, `MetroMcpProps`, `transit:read`, `WWW-Authenticate`, and Provider dispatch. Confirm the only historical/temporary OAuth references are the source and configuration that Task 2 will delete.

- [ ] Write `.superpowers/sdd/2026-08-21-metro-mcp-6-anonymous/task-1-report.md`, ending with `DONE`.

- [ ] Commit:

```bash
git add src tests
git diff --cached --check
git commit -m "feat: make Metro MCP anonymously accessible"
```

---

## Task 2: Delete OAuth implementation and prune the deployment contract

**Files:**

- Delete: `src/oauth/github-handler.ts`
- Delete: `src/oauth/provider.ts`
- Delete: `src/oauth/legacy-token.ts`
- Delete: `tests/unit/github-oauth.test.ts`
- Delete: `tests/unit/legacy-token.test.ts`
- Delete: `tests/unit/oauth-provider.test.ts`
- Delete: `tests/unit/oauth-provider-runtime.test.ts`
- Delete: any remaining Provider-composition test superseded in Task 1
- Modify: `package.json:1-55`
- Regenerate: `bun.lock`
- Modify: `src/config.ts:1-151`
- Modify: `src/types.ts:1-75`
- Modify: `.dev.vars.example`
- Modify: `wrangler.jsonc:1-114`
- Modify: `wrangler.jsonc.example`
- Modify: `tests/setup.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/unit/package-policy.test.ts`
- Modify: `vitest.workers.config.ts`

**Interfaces consumed:** Task 1 anonymous handler, `Config.mcp`, `Config.apis`, `Config.app`, `MCP_REQUEST_STATE_KEY`, `WMATA_API_KEY`, Assets binding, environment-specific Wrangler inheritance rules.

**Interfaces produced:**

```ts
export interface Config {
  mcp: {
    publicOrigin: string;
    resourceUri: string;
    allowedHostnames: string[];
    allowedOriginHostnames: string[];
    requestStateKey: string;
  };
  apis: { wmata: string };
  app: { environment: 'development' | 'preview' | 'production'; version: string };
}
```

- [ ] First add failing config/package-policy assertions that the repository and deployed contract have no `@cloudflare/workers-oauth-provider`, `OAUTH_KV`, `OAUTH_PROVIDER`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OAUTH_REDIRECT_URI`, `JWT_SECRET`, OAuth TTL/cutoff configuration, or OAuth-only source files.

- [ ] Add failing assertions that the canonical `.dev.vars.example` has exactly the anonymous string contract: public origin, Host allowlist, browser-Origin allowlist, request-state key, WMATA key, and environment.

- [ ] Add failing Wrangler assertions that production and preview contain only their own public vars/assets/rate-limit-independent configuration, cannot inherit the other environment's custom route, retain the inactive migration/class, and do not keep removed dashboard variables.

- [ ] Run the RED slice:

```bash
bunx vitest run --config vitest.config.ts tests/unit/config.test.ts tests/unit/package-policy.test.ts
```

- [ ] Remove the OAuth package using Bun so the text lockfile is regenerated by the package manager:

```bash
bun remove @cloudflare/workers-oauth-provider
```

- [ ] Delete the three OAuth modules and their unit tests. Remove OAuth types, Provider helpers, pending-login types, KV binding, GitHub variables, redirect URI, JWT secret, OAuth TTLs, and legacy cutoff from active types/config/tests.

- [ ] Set Wrangler `keep_vars` to `false`, remove OAuth KV namespaces and OAuth plaintext variables from production and preview, and keep the original migration and `MetroMcpAgent` export unchanged. Cloudflare's current Wrangler contract states that deployment never deletes encrypted secrets regardless of this flag; verify that contract again immediately before preview and production deploys so the final cleanup gate remains real.

- [ ] Rewrite `.dev.vars.example` and `wrangler.jsonc.example` to the anonymous 6.0 contract with non-secret placeholders. Never copy real values into examples.

- [ ] Make Workerd tests bind only anonymous runtime inputs and Assets. Remove Provider/KV test setup.

- [ ] Run focused tests and all repository gates:

```bash
bun install --frozen-lockfile
bun run type-check
bun run test
bunx wrangler deploy --dry-run --outdir /tmp/metro-mcp-v6-prod-dry
bunx wrangler deploy --env preview --dry-run --outdir /tmp/metro-mcp-v6-preview-dry
```

- [ ] Scan active source/config/bundles for removed names and assert they are absent. Separately assert `src/mcp-agent.ts`, the export, the SDK v1 dependency, and migration are byte-for-byte preserved.

```bash
rg -n "workers-oauth-provider|OAUTH_KV|OAUTH_PROVIDER|GITHUB_CLIENT|OAUTH_REDIRECT|JWT_SECRET|legacyJwt|createOAuthProvider" src tests package.json wrangler.jsonc wrangler.jsonc.example .dev.vars.example
rg -n "MetroMcpAgent|new_sqlite_classes|@modelcontextprotocol/sdk" src package.json wrangler.jsonc
```

- [ ] Write `.superpowers/sdd/2026-08-21-metro-mcp-6-anonymous/task-2-report.md`, ending with `DONE`, and commit:

```bash
git add -A
git diff --cached --check
git commit -m "refactor: remove Metro MCP OAuth infrastructure"
```

---

## Task 3: Add Cloudflare rate limiting for anonymous MCP traffic

**Files:**

- Create: `src/rate-limit.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Modify: `wrangler.jsonc`
- Modify: `wrangler.jsonc.example`
- Modify: `vitest.workers.config.ts`
- Modify: `tests/setup.ts`
- Create: `tests/unit/rate-limit.test.ts`
- Modify: `tests/unit/index-routing.test.ts`
- Modify: `tests/unit/config.test.ts`
- Modify: `tests/workers/mcp-worker.test.ts`

**Interfaces consumed:** Cloudflare global `RateLimit`, `CF-Connecting-IP`, normalized/trusted MCP request, correlation ID wrapper, existing top-level error boundary.

**Interfaces produced:**

```ts
export const MCP_RATE_LIMIT = 300;
export const MCP_RATE_LIMIT_PERIOD_SECONDS = 60;

export async function anonymousMcpRateLimitResponse(
  request: Request,
  limiter: RateLimit,
): Promise<Response | undefined>
```

- [ ] Add RED unit cases for accepted/denied outcomes, exact trusted-IP key, deterministic `local` fallback, a thrown binding error, exact 429 body, `Retry-After: 60`, and no raw IP in body or telemetry.

```ts
expect(await response.json()).toEqual({
  jsonrpc: '2.0',
  error: { code: -32029, message: 'Rate limit exceeded' },
  id: null,
});
expect(response.status).toBe(429);
expect(response.headers.get('Retry-After')).toBe('60');
```

- [ ] Add RED routing assertions proving only trusted normalized `/mcp` and `/sse` `POST` requests call `env.MCP_RATE_LIMITER.limit`; `OPTIONS`, `/info`, assets, legal pages, invalid origin/Host/Origin, unsupported methods, slash variants, and session-like paths do not consume quota.

- [ ] Add RED assertions that limiter denial never creates the MCP handler and limiter failure returns the generic fail-closed 500 with a correlation ID.

- [ ] Add RED configuration assertions for exact binding name `MCP_RATE_LIMITER`, distinct production namespace `2026082101`, distinct preview namespace `2026082102`, and identical initial simple policy `limit: 300`, `period: 60`.

- [ ] Run RED:

```bash
bunx vitest run --config vitest.config.ts tests/unit/rate-limit.test.ts tests/unit/index-routing.test.ts tests/unit/config.test.ts
bunx vitest run --config vitest.workers.config.ts tests/workers/mcp-worker.test.ts
```

- [ ] Implement the small boundary in `src/rate-limit.ts`. Use only Cloudflare's `CF-Connecting-IP` when present; use `local` for local tests/development. Do not accept forwarded-IP or MCP/header identity as the key.

- [ ] Call the limiter in `src/index.ts` only after route normalization and trust validation, immediately before `handleMcpRequest`. Let binding exceptions reach the existing generic error boundary.

- [ ] Add the binding to `Env`:

```ts
MCP_RATE_LIMITER: RateLimit;
```

- [ ] Add explicit, non-inherited Wrangler bindings:

```json
"ratelimits": [
  {
    "name": "MCP_RATE_LIMITER",
    "namespace_id": "2026082101",
    "simple": { "limit": 300, "period": 60 }
  }
]
```

Preview repeats the shape with namespace `2026082102`.

- [ ] Configure the Workerd pool's rate limiter and test actual quota denial/recovery behavior at the public Worker boundary, not only the helper mock.

- [ ] Run focused tests, type-check, unit, Workerd, combined, and both Wrangler dry-runs. Confirm the dry-run binding inventory contains exactly one rate limiter per environment and no OAuth/KV binding.

- [ ] Self-review Cloudflare limitations: per-location approximate enforcement, shared-IP grouping, no application identity, only 10/60-second periods. Ensure docs will not claim global/exact quotas.

- [ ] Write `.superpowers/sdd/2026-08-21-metro-mcp-6-anonymous/task-3-report.md`, ending with `DONE`, and commit:

```bash
git add src tests wrangler.jsonc wrangler.jsonc.example vitest.workers.config.ts
git diff --cached --check
git commit -m "feat: rate limit anonymous MCP traffic"
```

---

## Task 4: Prepare 6.0 metadata, conformance, docs, and connection instructions

**Files:**

- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `src/server-info.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/mcp-2026-verification.md`
- Modify: `docs/mcp-apps-verification.md`
- Modify: `public/index.html`
- Modify: `public/docs/index.html`
- Modify: `scripts/run-conformance.sh`
- Delete: `scripts/conformance-auth-proxy.ts`
- Delete: `tests/unit/conformance-auth-proxy.test.ts`
- Modify: `tests/unit/conformance-runner.test.ts`
- Modify: `tests/unit/server-info.test.ts`
- Modify: `tests/unit/release-docs.test.ts`
- Delete: `poke_issue.md`

**Interfaces produced:** `SERVER_VERSION = '6.0.0'`; `/info.authentication.type = 'none'`; direct conformance runner requiring only `MCP_CONFORMANCE_TARGET_URL`.

- [ ] Add RED release assertions for package/server `/info` version 6.0.0, anonymous authentication metadata, no OAuth endpoint/discovery metadata, canonical repo owner `Aarekaz`, and canonical legal URLs.

- [ ] Add RED doc assertions that active README/security/verification/landing/docs pages contain an anonymous connection example and no login, bearer-token, OAuth callback, registration, GitHub App, token proxy, or retired secret instructions.

- [ ] Add RED runner assertions that `scripts/run-conformance.sh` requires only `MCP_CONFORMANCE_TARGET_URL`, runs the frozen 2026-07-28 list and server commands directly against that target, starts no proxy, and never reads a token.

- [ ] Run RED:

```bash
bunx vitest run --config vitest.config.ts \
  tests/unit/server-info.test.ts \
  tests/unit/release-docs.test.ts \
  tests/unit/conformance-runner.test.ts
```

- [ ] Set `package.json` and `SERVER_VERSION` to `6.0.0`. Do not hand-edit unsupported root-version metadata into `bun.lock`; prove the lock remains frozen.

- [ ] Rewrite `/info` so endpoints advertise `/mcp` and `/sse`, authentication is `{ type: 'none' }`, capabilities remain accurate, and links point to `https://github.com/Aarekaz/metro-mcp` plus canonical privacy/terms/support URLs.

- [ ] Add a 6.0 changelog entry describing the breaking anonymous cutover, rate limiting, and legal pages. Preserve historical OAuth entries as historical release documentation.

- [ ] Update active README/security/verification/App docs and public connection snippets for anonymous Claude, Codex, and generic HTTP clients. State that stale Authorization headers are ignored and no credentials are collected.

- [ ] Reduce `scripts/run-conformance.sh` to:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${MCP_CONFORMANCE_TARGET_URL:?MCP_CONFORMANCE_TARGET_URL is required}"
bunx @modelcontextprotocol/conformance list --requirements 2026-07-28
bunx @modelcontextprotocol/conformance server \
  --url "$MCP_CONFORMANCE_TARGET_URL" \
  --requirements 2026-07-28
```

- [ ] Delete the auth proxy, proxy tests, and obsolete OAuth incident note. Keep no active references to them.

- [ ] Run focused tests, all types/tests, shell syntax, frozen install, conformance frozen-list count, and both dry-runs.

- [ ] Run a scoped accuracy scan. OAuth terms may remain only in historical changelog/spec/task records or explicit 6.0 removal statements, never as active setup/security behavior.

- [ ] Write `.superpowers/sdd/2026-08-21-metro-mcp-6-anonymous/task-4-report.md`, ending with `DONE`, and commit:

```bash
git add -A
git diff --cached --check
git commit -m "docs: prepare anonymous Metro MCP 6.0 release"
```

---

## Task 5: Publish privacy, terms, and support pages with browser acceptance

**Files:**

- Create: `public/legal.css`
- Create: `public/privacy/index.html`
- Create: `public/terms/index.html`
- Create: `public/support/index.html`
- Modify: `public/index.html`
- Modify: `public/docs/index.html`
- Create: `tests/unit/legal-pages.test.ts`
- Create: `tests/apps/legal-pages.spec.ts`
- Modify: `playwright.apps.config.ts`

**Page contract:** Static HTML only; no JavaScript, form, analytics, cookie, tracking pixel, external font, third-party stylesheet, browser storage, or permission use. Each page has a canonical URL, descriptive title/meta description, landmark structure, visible focus states, last-updated date `August 21, 2026`, and links back to Metro MCP.

- [ ] Add RED unit tests that load the real files and require:
  - `/privacy/`: no account requirement; request transit inputs reach WMATA/MTA; Metro-owned allowlisted telemetry; Cloudflare/provider logs may exist; no sale/ads/tracking; contact/support link.
  - `/terms/`: public read-only informational service; upstream availability/accuracy limits; fair-use/rate-limit terms; no emergency reliance; no warranty; MIT/source link.
  - `/support/`: `/docs/`, `/info`, GitHub issues, and GitHub private vulnerability reporting; response expectations must avoid an unverified SLA.
  - all pages: no script/form/storage/tracker/external-origin reference and no OAuth-era promises.

- [ ] Verify GitHub private vulnerability reporting is actually enabled for `Aarekaz/metro-mcp` before publishing that link. If it is disabled, enable it only with owner-authorized repository scope or link to the repository Security tab without claiming the private form.

- [ ] Add RED Playwright cases at 1280×960 and 320×800 for correct content, landmarks, keyboard focus, internal link targets, no horizontal overflow, no page/console errors, no external requests, no storage writes, and no permission attempts.

- [ ] Run RED:

```bash
bunx vitest run --config vitest.config.ts tests/unit/legal-pages.test.ts
bun run test:apps -- --grep "legal|privacy|terms|support"
```

- [ ] Implement shared `public/legal.css` and all three scriptless pages. Use the existing Metro landing-page visual language without copying runtime App CSS or adding a framework.

- [ ] Add visible Privacy, Terms, and Support links to both public footers. Make the canonical home and docs pages describe anonymous access accurately.

- [ ] Expand `playwright.apps.config.ts` test matching to include both `transit-board.spec.ts` and `legal-pages.spec.ts`; keep one worker, zero retries, and the fresh managed Chromium server.

- [ ] Run focused unit/browser tests, then the complete three-run Apps acceptance:

```bash
bun run test:apps
bun run test:apps
bun run test:apps
```

- [ ] Inspect actual desktop/mobile screenshots for all three pages. Verify legal copy is legible and the footer links are visible on the rendered landing/docs pages.

- [ ] Run `bun run type-check`, `bun run test`, a deterministic double Apps build, and both Wrangler dry-runs. Scan built HTML for scripts, external origins, trackers, forms, and storage APIs.

- [ ] Write `.superpowers/sdd/2026-08-21-metro-mcp-6-anonymous/task-5-report.md`, ending with `DONE`, and commit:

```bash
git add public tests playwright.apps.config.ts
git diff --cached --check
git commit -m "feat: publish Metro MCP legal and support pages"
```

---

## Task 6: Close local verification and security review

**Files:**

- Create: `docs/mcp-6-verification.md`
- Modify only if evidence exposes a defect: the smallest production/test/doc files necessary to fix it

**Evidence produced:** A source-linked verification matrix that distinguishes automated, local-live, preview-live, production-live, and pending external cleanup.

- [ ] Start from a clean tree and run the immutable install/type/unit/Workerd/combined gates:

```bash
bun install --frozen-lockfile
bun run type-check
bun run test:unit
bun run test:workers
bun run test
```

- [ ] Build Transit Board twice from a clean artifact directory and require identical byte size and SHA-256. Run the full managed-Chromium Apps/legal suite three independent times with zero retries.

- [ ] Run production and preview Wrangler dry-runs. Assert each inventory has Assets, one distinct rate limiter, the intended public vars, no OAuth KV/provider/secrets, and the retained rollback class/migration.

- [ ] Start local Wrangler on `127.0.0.1:8787` with the anonymous `.dev.vars` contract. Verify `/info`, privacy/terms/support, anonymous `server/discover`, exact 13/3/3 lists, DC and NYC real transit calls, resource, prompt, App resource, progress, cancellation, modern MRTR, 2025 compatibility, `/sse`, unsupported-method matrix, stale bearer equivalence, and retired OAuth-route 404s.

- [ ] Run frozen conformance directly:

```bash
MCP_CONFORMANCE_TARGET_URL=http://127.0.0.1:8787/mcp ./scripts/run-conformance.sh
```

- [ ] Search captured local logs for the exact stale-bearer canary and representative request arguments; both must be absent. Search the bundle/source for OAuth provider, retired bindings, tokens, secrets, and removed proxy code.

- [ ] Invoke the `codex-security:security-diff-scan` skill over `origin/main...HEAD`. Triage every candidate by actual request path and trust boundary. Fix validated findings under RED-GREEN before proceeding.

- [ ] Request an independent code review of the complete range, requiring spec verdict, quality verdict, Critical/Important/Minor findings, and fresh focused/full gates. Address all Critical or Important findings and rereview until approved.

- [ ] Write `docs/mcp-6-verification.md` with exact counts, hashes, commands, environment boundaries, known Cloudflare rate-limit limitations, and explicit pending preview/production/cleanup items.

- [ ] Run a final placeholder and truthfulness scan:

```bash
placeholder_pattern='TO''DO|TB''D|FIX''ME|PLACE''HOLDER|not y''et|to be determ''ined'
rg -n "$placeholder_pattern" docs README.md public src tests scripts
git diff --check origin/main...HEAD
```

- [ ] Write `.superpowers/sdd/2026-08-21-metro-mcp-6-anonymous/task-6-report.md`, ending with `DONE`, and commit:

```bash
git add docs tests src public scripts
git diff --cached --check
git commit -m "docs: record Metro MCP 6.0 verification"
```

---

## Task 7: Deploy preview, calibrate the rate limit, and run live clients

**External changes:** Deploys the preview Worker and may update the preview rate-limit threshold. It does not change production or delete OAuth infrastructure.

- [ ] Verify `wrangler whoami`, the Cloudflare account ID, preview custom domain, branch HEAD, clean tree, author metadata, and that no secret values will be printed.

- [ ] Build and deploy preview from the exact reviewed branch commit:

```bash
bun run build:apps
bunx wrangler deploy --env preview
```

- [ ] Verify live preview `/info`, `/privacy/`, `/terms/`, `/support/`, anonymous `server/discover`, exact 13/3/3 catalog, App resource, DC/NYC calls, resource, prompt, progress, cancellation, modern MRTR, MCP 2025, `/sse`, retired OAuth-route 404s, stale bearer equivalence, and Host/Origin/method/session rejection.

- [ ] Run the direct frozen server conformance suite against preview and record exact passed/failed requirement counts:

```bash
MCP_CONFORMANCE_TARGET_URL=https://metro-mcp-preview.anuragd.me/mcp ./scripts/run-conformance.sh
```

- [ ] Connect Claude without login, make one DC and one NYC call, then remove the temporary entry:

```bash
claude mcp add --transport http --scope local metro-mcp-v6-preview https://metro-mcp-preview.anuragd.me/mcp
claude mcp list
claude mcp remove --scope local metro-mcp-v6-preview
```

- [ ] Connect Codex without login, inspect the entry, make one DC and one NYC call in a fresh client session, then remove it:

```bash
codex mcp add metro-mcp-v6-preview --url https://metro-mcp-preview.anuragd.me/mcp
codex mcp get metro-mcp-v6-preview --json
codex mcp remove metro-mcp-v6-preview
```

- [ ] Measure at least three legitimate client bursts, including catalog discovery plus App resource loading, and record the maximum accepted MCP POST count per source IP per minute.

- [ ] Drive more than 300 trusted preview `server/discover` POSTs from a bounded test client. Assert successful responses before the threshold, exact 429 shape/headers after denial, no MCP dispatch while denied, and recovery after the configured window. Do not run this against production.

- [ ] Set the release threshold to the greater of ten times the measured legitimate burst and 300 requests/minute, unless the WMATA quota requires a lower upstream-safe ceiling. Document the measurement and rationale; do not claim global precision.

- [ ] If calibration changes the threshold, update both Wrangler environments, config tests, Workerd tests, and docs under RED-GREEN. Rerun Task 6 gates and commit:

```bash
git commit -m "chore: calibrate anonymous MCP rate limits"
```

- [ ] Inspect preview logs/tails for the stale bearer canary, request bodies, and transit inputs; none may appear. Record only allowlisted operational telemetry and rate-limit status.

- [ ] Update `docs/mcp-6-verification.md` with preview deployment ID, exact branch SHA, live results, client cleanup status, and calibrated threshold. Commit:

```bash
git commit -m "docs: record Metro MCP 6.0 preview acceptance"
```

- [ ] Stop before production. Report any unresolved live failure rather than weakening the test.

---

## Task 8: Review, merge, deploy production, and retire external OAuth state

**External changes:** Pushes the branch, creates/merges the PR, deploys production, and—only after a final owner confirmation—deletes retired Cloudflare/GitHub OAuth state.

- [ ] Rebase or merge the current `origin/main` into the feature branch without rewriting reviewed commits unless necessary. Rerun the full Task 6 gate and preview smoke if the base changed.

- [ ] Push the branch and create one feature PR with the design, breaking-change warning, exact test evidence, preview URL, rate-limit calibration, rollback boundary, and explicit cleanup hold.

- [ ] Verify every commit author is Anurag, all GitHub checks pass, and the PR diff contains no unrelated files, secrets, generated browser state, local vars, or test output.

- [ ] Run a final independent full-range review and security diff scan on the exact PR head. Resolve every Critical/Important item under TDD and rerun affected plus full gates.

- [ ] Mark the PR ready only after review approval, then merge using the repository's established merge policy. Resolve the exact merge commit SHA from `origin/main`.

- [ ] Deploy the exact merged commit from a fresh release worktree. Do not switch, reset, or otherwise modify the user's dirty main checkout:

```bash
git fetch origin main
pr_url="$(gh pr view --json url --jq .url)"
release_sha="$(gh pr view "$pr_url" --json mergeCommit --jq .mergeCommit.oid)"
git merge-base --is-ancestor "$release_sha" origin/main
git worktree add /private/tmp/metro-mcp-release-v6 "$release_sha"
cd /private/tmp/metro-mcp-release-v6
bun install --frozen-lockfile
bun run deploy
```

- [ ] Verify the deployed version/hash, then repeat the full preview acceptance matrix on `https://metro-mcp.anuragd.me`, excluding deliberate rate-limit exhaustion. Run direct conformance, anonymous Claude/Codex DC+NYC calls, stale bearer equivalence, legal pages, 13/3/3 catalog, App, MRTR, progress/cancellation, 2025, `/sse`, trust boundaries, and OAuth-route 404s.

- [ ] Confirm production logs do not contain the stale bearer canary or request data. Confirm the rate limiter is present and normal acceptance traffic stays below the calibrated threshold.

- [ ] Enumerate by name/ID only: production and preview `GITHUB_CLIENT_SECRET`, `JWT_SECRET`, dedicated OAuth KV namespaces, and the two exact GitHub OAuth Apps. Verify ownership and prove no active Worker/config/client references them.

- [ ] **STOP and ask Anurag for final explicit confirmation before the irreversible cleanup.** Do not infer approval from the earlier 6.0 cutover decision.

- [ ] After confirmation, delete only the verified retired secrets in both environments:

```bash
bunx wrangler secret delete GITHUB_CLIENT_SECRET
bunx wrangler secret delete JWT_SECRET
bunx wrangler secret delete GITHUB_CLIENT_SECRET --env preview
bunx wrangler secret delete JWT_SECRET --env preview
```

- [ ] Delete only the verified retired production/preview OAuth KV namespaces and exact Metro MCP GitHub OAuth Apps. Record IDs/names and deletion success, never values.

- [ ] Repeat production and preview anonymous smoke, conformance discovery, DC/NYC, legal pages, retired OAuth 404s, and secret/binding inventories after cleanup.

- [ ] Update `docs/mcp-6-verification.md` with the merge SHA, deployment ID, production acceptance, cleanup confirmation/time, deleted names/IDs, post-cleanup verification, and remaining external directory-submission work on a new evidence branch from the merged commit.

- [ ] Commit and push the final evidence as a small follow-up PR; do not write directly to the already merged feature branch or the user's dirty main checkout:

```bash
git switch -c docs/metro-mcp-6-production-evidence
git commit -m "docs: record Metro MCP 6.0 production acceptance"
git push -u origin docs/metro-mcp-6-production-evidence
```

- [ ] Create the separate follow-up for OpenAI/Codex directory and Claude Marketplace submission assets. Do not mix marketplace packaging into the 6.0 runtime PR.

---

## Completion Gate

Metro MCP 6.0 is complete only when all of the following are true:

- [ ] Anonymous Claude, Codex, conformance, and raw MCP clients work without login in production.
- [ ] The exact 13/3/3 and Transit Board contracts pass local, preview, and production acceptance.
- [ ] OAuth source, package, bindings, active docs, endpoints, and runtime behavior are absent.
- [ ] Production and preview have distinct, measured Cloudflare rate limits.
- [ ] Privacy, terms, and support pages pass unit and real-browser acceptance and return 200 live.
- [ ] Host/origin/protocol/cancellation/progress/MRTR/legacy/telemetry boundaries remain verified.
- [ ] The inactive Durable Object rollback class, export, SDK v1 dependency, and original migration remain intact.
- [ ] The PR is reviewed, security-approved, merged, and the exact merged commit is deployed.
- [ ] Retired external OAuth secrets/KV/apps are deleted only after explicit final owner confirmation, with post-cleanup smoke green.
- [ ] Directory submission packaging remains a separate, clearly tracked follow-up.
