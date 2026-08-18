# Task 13 review fix round 4 report

## Outcome

- Completed a source-verified audit of the remaining runtime claims in `docs/SECURITY.md` against the active Worker, transit adapters, OAuth renderer, telemetry serializer, unit/Workerd tests, deployment configuration, and the pinned OAuth Provider documentation.
- Replaced the universal upstream-error claim with the exact adapter behavior: thrown WMATA and other uncaught non-cancellation adapter failures reach the shared operational-error boundary; MTA prediction-feed failures may yield partial or empty predictions; MTA incident-feed failures yield empty incidents; MTA aborts rethrow.
- Replaced the obsolete inline-script OAuth callback description with the active escaped, server-rendered consent/error forms, exact no-script CSP, no-referrer policy, no-store response policy, and no-untrusted-HTML boundary.
- Replaced raw-error diagnostic guidance with the exact structured telemetry allowlist and an explicit prohibition on raw error objects, tokens, secrets, and user payloads.
- Limited the 90-day lifetime to dynamically registered clients. Configured pre-registered clients are outside the DCR TTL and persist until revoked or removed under their lifecycle; CIMD is resolved metadata rather than a stored DCR record.
- Corrected related source-verified overclaims found in the full audit: the Worker has no application rate limiter; application telemetry does not expose authentication or edge-rate detail; production/preview require HTTPS while loopback development may use HTTP; dependency evidence is exact-pin/frozen-install review rather than a blanket current-version claim; public-error review is not presented as a universal runtime guarantee.
- No runtime, configuration, dependency, lockfile, conformance harness, rollback asset, or ledger file changed.

## TDD evidence

- RED: three new release-document regressions failed with 3 failures and 2 passes on the universal upstream-error claim, obsolete inline-script/raw-error guidance, and universal client TTL.
- GREEN: after the documentation correction, the focused release-document gate passed all 5 tests.
- The regressions assert the public release claims and their critical exclusions; they add no duplicate runtime validation or behavior.

## Local verification

- `bun install --frozen-lockfile`: pass; 421 installs checked across 521 packages with no changes.
- `bun run type-check`: pass for source and test TypeScript programs.
- `bun run test`: pass after the local Workerd gate was permitted to bind loopback and write Wrangler logs; 25 unit files with 337 tests and 2 Workerd files with 25 tests. Missing upstream sourcemaps were warnings only.
- Production Wrangler dry-run: pass in `/tmp/metro-mcp-task13-fix4-production.ShQA5Y`; no upload or deployment.
- Preview Wrangler dry-run: pass in `/tmp/metro-mcp-task13-fix4-preview.xb35HH`; no upload or deployment.
- Conformance version/list: pass with exact `@modelcontextprotocol/conformance` `0.2.0-alpha.11`; the frozen `2026-07-28` manifest lists 69 scored scenarios (37 server and 32 client).
- `bash -n scripts/run-conformance.sh`: pass; the full suite also retains the conformance runner lifecycle and cleanup coverage.
- `git diff --check`, Bun-only lockfile, stale-security-claim, runtime/config/dependency, active-v1 import, rollback/deletion, MCP Apps, and ledger scans: pass. The verification record now reports the fresh 337-unit-test count.

## Honest pending work

Authenticated MCP conformance, the generic authorization runner, modern MRTR through Workerd and real clients, preview deployment/DNS/tails, Claude and Codex acceptance, and production deployment remain pending. No credential was generated, read, stored, or recorded. No deployment, secret operation, DNS/GitHub mutation, push, PR, or other external mutation occurred.

DONE
