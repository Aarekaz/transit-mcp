# Task 11 Report: MCP 2026 and OAuth in Workerd

## RED evidence

- The first Workerd run did not reach a test: `@cloudflare/vitest-pool-workers@0.16.10` imported the removed Vitest 2 `@vitest/utils.toArray` API under the pinned Vitest 4.1.10 runtime. Local package inspection confirmed that `0.16.20`, the final 0.16 patch, retains the required Vitest `^4.1.0` peers and removes the incompatible import.
- After that test-stack repair, the assembled MCP suite reached 10/11: cancelling the response after the first progress event did not abort the mocked WMATA request.
- A focused handler regression suite was then RED at 1/4. The already-aborted incoming request passed, while response cancellation, normal-EOF listener cleanup, and handler-failure cleanup failed against the prior production handler.
- The assembled OAuth tests also caught two incorrect planned assumptions during GREEN work: service-binding fetch follows redirects unless the test Request uses `redirect: "manual"`, and Provider 0.10.3 retry grace rotates a fresh refresh token rather than replaying the first successor.

## Production correction

The installed SDK 2.0.0 `PerRequestHTTPServerTransport` listens to the request signal, but its response-body cancellation only closes the transport and never aborts that signal. `src/mcp/http-handler.ts` now installs the minimal request-scoped bridge:

- an `AbortController` forwards an incoming abort with the exact reason identity;
- the SDK handler receives a Request carrying the linked signal;
- response cancellation aborts the linked controller before delegating the exact reason to the SDK response reader;
- incoming listeners are removed on EOF, stream error, cancellation, a bodyless response, and handler failure;
- response status, status text, headers, and ordinary body streaming are preserved.

The focused bridge suite is GREEN at 4/4, including exact custom-reason identity, pre-aborted input, normal EOF without a spurious abort, and rejection cleanup.

## Assembled MCP coverage

Eleven Workerd tests exercise the production entry and real OAuth Provider path:

- RFC 9728 unauthenticated challenge;
- MCP 2026 `server/discover` without initialize;
- exact 13-tool, 3-resource-template, and 3-prompt surfaces;
- representative tools, resources, prompts, and permitted cache hints;
- ordinary 2025 stateless list/call behavior and ambiguity retry guidance;
- exact `/mcp` and `/sse` method/alias boundaries;
- ignored query credentials;
- SDK version/method/name mismatch errors;
- allowed and rejected Host/Origin cases plus Origin-less desktop access;
- progress ordering over request-scoped SSE;
- response cancellation aborting the mocked upstream request.

All outbound fetches fail closed by default. Only the representative transit request is mocked.

## Assembled OAuth coverage

Eleven Workerd tests use real Provider 0.10.3 routes and isolated real `OAUTH_KV` behavior while mocking only GitHub and CIMD network calls:

- authorization-server and protected-resource discovery;
- 90-day DCR expiration announcement and exact redirect matching;
- valid CIMD and unsafe scheme/private-host/bad-redirect rejection;
- oversized, wrong-content-type, malformed-JSON, and real 10-second timeout rejection;
- missing challenge, plain PKCE, missing verifier, mismatched verifier, and successful S256 exchange;
- explicit GitHub approve/deny, one-time GitHub state, one-time consent state, and RFC 9207 `iss`;
- exact RFC 8707 resource and `transit:read` propagation through authorization, exchange, MCP access, and refresh;
- 60-minute access-token lifetime and observable 30-day refresh-grant expiration;
- rotation, the installed Provider's previous-token retry grace, abandoned-successor rejection, family revocation, and rejection of old/current access and refresh tokens;
- canonical legacy JWT acceptance before the cutoff, plus missing audience, `/sse` audience, query transport, and absolute-cutoff rejection.

No test inspects undocumented Provider KV record shapes, and every unmatched external request fails the test.

## Verified deviations

- The superseded plan pin `@cloudflare/vitest-pool-workers@0.16.10` cannot execute with Vitest 4.1.10. The authorized minimal correction is exact `0.16.20` plus the regenerated sole `bun.lock`; runtime MCP/OAuth pins remain unchanged.
- The current Vitest 4 Cloudflare pool no longer exports `fetchMock`. The suite uses `vi.spyOn(globalThis, "fetch")`, as supported by the installed runtime, with a fail-closed default.
- `SELF.fetch()` and `cloudflare:workers` `exports.default.fetch()` cross a service/JSRPC boundary that does not propagate consumer response cancellation into the Worker isolate. A localized probe failed through both boundaries. The cancellation assertion therefore uses the documented same-isolate direct production-module entry with `cloudflare:workers` `env` and `createExecutionContext()`; all other assembled protocol and OAuth assertions remain on `SELF`.
- Provider 0.10.3 accepts a previous refresh token once but issues another fresh refresh/access pair; it does not return the first successor. The test follows that installed public behavior and proves that the abandoned successor is rejected.
- The announced `2027-06-30` DCR sunset is documentation owned by Task 13 and is not present at this Task 11 base, so this task does not create a premature assertion against future documentation. The observable DCR expiration contract is covered here.
- Existing Task 2 test typing already included `tests/**/*.ts`, `src/**/*.ts`, the Workerd config, and Cloudflare pool types, so no additional `tests/tsconfig.json` edit was necessary.

## Verification

- `bun install --frozen-lockfile` — passed; 421 installs across 521 packages, no changes.
- `bun run type-check` — passed for production and test TypeScript programs.
- `bun run test:unit` — 22 files and 309 tests passed.
- `bun run test:workers` — 2 files and 22 tests passed.
- `bun run test` — combined 309 unit plus 22 Workerd tests passed.
- `bun run build` — passed (the repository intentionally delegates bundling to Wrangler).
- `bunx wrangler deploy --dry-run --outdir /private/tmp/metro-mcp-task11-dry-run` — passed; 1,787.35 KiB / 432.36 KiB gzip, no deployment.
- `git diff --check` — passed.

Wrangler remains intentionally unchanged and still reports the rollback-era resources that Task 12 owns. No deployment, secret mutation, external resource change, push, or ledger edit occurred. Dependency sourcemap warnings in the Workerd output are non-fatal upstream packaging warnings.

DONE
