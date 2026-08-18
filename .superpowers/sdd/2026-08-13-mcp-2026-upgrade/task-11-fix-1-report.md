# Task 11 Fix 1 Report: Protocol and Token Expiry Boundaries

Reviewed commit: `7c9d6550ffad4391732f280feac159e87681b2d1`

## RED evidence

- A real metadata-bearing `server/discover` request with only `MCP-Protocol-Version` removed returned HTTP `200` through `SELF`, not the required `400` / `-32020`. The installed SDK 2.0.0 classifier intentionally treats the body claim as modern but cross-checks the version header only when present, so this was a real Metro conformance gap rather than a test-only omission.
- The new 60-minute access boundary initially passed against the configured Provider. A focused mutation changed only `accessTokenTTL` from 3,600 to 7,200 seconds; at issuance plus 3,601 seconds the new regression failed with HTTP `200` instead of `401`. The mutation was immediately reverted, and `src/oauth/provider.ts` has no final diff.
- The requested DCR fake-time probe registered a real confidential client in Workerd KV, advanced Vitest time by 7,776,001 seconds, and attempted an otherwise-valid S256 authorization. The probe expected expiry but failed with HTTP `302` instead of `400`, proving that advancing the Worker clock does not advance the KV simulator's expiration clock.

## MCP conformance correction

- `handleMcpRequest` now calls the SDK v2 public, body-preserving `isLegacyRequest(request)` classifier only when `MCP-Protocol-Version` is absent.
- A headerless request classified as modern receives HTTP `400`, JSON-RPC `-32020`, and its string/number request ID when the ID can be safely read.
- Ordinary headerless 2025 requests continue to the existing stateless compatibility path; the assembled regression verifies the exact 13-tool list remains available.
- No other standard header is reimplemented or changed, and the SDK remains responsible for era classification and all existing mismatch validation.

## OAuth expiry correction

- A real Provider-issued access token succeeds immediately in the existing lifecycle test, then the new boundary advances to issuance plus 3,601 seconds.
- MCP access returns HTTP `401`, a `WWW-Authenticate` invalid-token challenge, and JSON `invalid_token`.
- The original refresh token still exchanges successfully at that time with the canonical resource and a new 3,600-second access lifetime, proving access expiry does not destroy the 30-day refresh grant.

## DCR technical pushback

- Provider 0.10.3 persists dynamic clients with only `OAUTH_KV.put("client:${id}", ..., { expirationTtl: clientRegistrationTTL })` and resolves them with a direct KV `get`; its lookup performs no `Date.now()` or `registrationDate` expiry check.
- The installed Miniflare/pool public configuration types expose no supported clock or time-travel control for KV expiration. Vitest fake timers affect Worker `Date`/timers, not simulator storage expiry, as the localized real-route probe demonstrated.
- An accelerated end-to-end 90-day expiry assertion would therefore require waiting 90 days or reading/deleting the undocumented `client:${id}` storage key. Both violate the Task 11 constraints, so neither was added.
- The supported observable contract is strengthened safely: a newly registered confidential client resolves through an otherwise-valid authorization before expiry, its exact `client_id_issued_at + 7_776_000` expiration is asserted, and exact redirect matching remains enforced. This cannot prove the simulator's 90-day deletion without crossing the prohibited storage-shape boundary.

## Verification

- Focused protocol/OAuth/DCR Workerd tests — 4/4 passed.
- `bun run test:workers` — 2 files and 25 tests passed.
- `bun run type-check` — production and test TypeScript programs passed.
- `bun run test:unit` — 22 files and 309 tests passed.
- `bun run test` — the combined command passed all 309 unit and 25 Workerd tests.
- `bun install --frozen-lockfile` — 421 installs across 521 packages checked with no changes.
- `bun run build` — passed; the repository intentionally delegates bundling to Wrangler.
- `bunx wrangler deploy --dry-run --outdir /private/tmp/metro-mcp-task11-fix1-dry-run` — passed without deployment; 1,787.81 KiB / 432.54 KiB gzip.
- `git diff --check` — passed.

No Provider behavior, dependency, lockfile, Wrangler binding, external resource, secret, deployment, push, or ledger change was made.

DONE
