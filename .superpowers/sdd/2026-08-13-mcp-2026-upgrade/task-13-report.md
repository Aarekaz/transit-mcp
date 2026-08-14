# Task 13 implementation report

## Outcome

- Release metadata now consistently advertises Metro MCP `5.0.0`, MCP `2026-07-28`, canonical `/mcp`, stateless Streamable HTTP, exact `transit:read`, and the 13-tool/3-resource/3-prompt surface.
- `mcp-config.json` is a direct remote-HTTP example for canonical `/mcp`.
- README, security, and changelog document MCP 2026/2025 compatibility, `/sse` alias boundaries, Provider OAuth/CIMD/DCR, reauthorization and cutoff rules, environment isolation, rollback, Claude/Codex setup, and the deliberate MCP Apps deferral.
- The authenticated conformance proxy binds only `127.0.0.1`, validates target/token/port, denies remote targets by default, replaces inbound Authorization, preserves request behavior, uses manual redirects, and redacts proxy failures.
- The runner validates inputs, traps cleanup, waits for health, unsets the token before invoking conformance, verifies the frozen requirements pin, and runs the server suite without a token argument.
- `docs/mcp-2026-verification.md` records executed local evidence and clearly separates every approval-gated live check as pending.

## TDD evidence

- RED: release-contract test received `4.0.0` where `5.0.0` was required.
- GREEN: release metadata/client-config tests pass.
- RED: proxy security tests failed on the initial unimplemented contract.
- GREEN: eight proxy boundary tests pass.
- RED/GREEN: runner validation and token-environment containment were observed failing before their minimal implementations; syntax and lifecycle cleanup are covered.

## Local verification

- `bun install --frozen-lockfile`: pass, 421 installs across 521 packages, no change.
- `bun run type-check`: pass for both TypeScript programs.
- `bun run test:unit`: pass, 24 files and 330 tests.
- `bun run test:workers`: pass, 2 files and 25 tests.
- `bun run test`: pass in the final combined gate, 330 unit tests and 25 Workerd tests.
- production and preview Wrangler dry-runs: pass in fresh `/tmp` directories; no upload.
- conformance list sanity: pass, 69 frozen `2026-07-28` scenarios (37 server, 32 client).
- actual local proxy lifecycle probe: pass with a dummy token, exact loopback binding, path/query forwarding, and cleanup.
- `bash -n scripts/run-conformance.sh`: pass.
- `git diff --check` and scoped secret/placeholder/app/v1-import/rollback scans: pass; historical changelog references remain historical.

## Honest pending work

Authenticated MCP conformance, the generic authorization runner, preview deployment/DNS/tails, Claude and Codex acceptance, and production deployment were not run. They require separately approved infrastructure/secrets and an operator-obtained short-lived Provider token. No credential was generated, read, stored, or recorded.

## Bun lockfile note

Bun `1.3.14` does not serialize the root package version in `bun.lock`. After `package.json` changed to `5.0.0`, `bun install` correctly reported no lockfile change. The generated lockfile was not hand-edited with unsupported metadata, and the frozen install passes.

DONE
