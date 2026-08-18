# Task 13 review fix round 1 report

## Outcome

- Metro's custom `/info` payload no longer advertises `tools.listChanged`; it now mirrors the real SDK wire's empty tools capability while retaining the exact 5.0 release contract and stateless/no-server-push metadata. The SDK wire capability implementation was not changed.
- The verification record now assigns modern `input_required` MRTR and signed-state coverage to the unit suite only. Modern MRTR through Workerd, authenticated conformance, and real preview clients is explicitly pending and is not claimed as executed.
- The live SDK v2 incident resource description now describes current stateless, read-only, request-fetched data. The matching golden fixture is aligned. The inactive 4.0 rollback class remains untouched.
- The README now includes all four preview secret commands with `--env preview` and explains that named Wrangler environments do not inherit production secrets.

## TDD evidence

- RED: the `/info` regression received `{ listChanged: true }` where the no-server-push contract required `{}`.
- RED: the live incident resource regression received the stale 4.0/Phase 2.5 roadmap description instead of the current stateless/read-only description.
- RED: the release-document regression could not find any of the four required `--env preview` secret commands.
- GREEN: the focused implementation tests passed after the minimal source and documentation changes. The final focused gate passed 58 tests across server info, MCP catalog, release docs, conformance proxy, and conformance runner files.

## Local verification

- `bun install --frozen-lockfile`: pass, 421 installs across 521 packages with no lockfile change.
- `bun run type-check`: pass for both source and test TypeScript programs.
- `bun run test`: pass, 25 unit files with 332 tests and 2 Workerd files with 25 tests.
- Focused review/proxy/runner gate: pass, 5 files and 58 tests.
- Production Wrangler dry-run: pass in `/tmp/metro-mcp-task13-fix-production.FPaaOZ`; no upload or deployment.
- Preview Wrangler dry-run: pass in `/tmp/metro-mcp-task13-fix-preview.PhHQKi`; no upload or deployment.
- Conformance pin: pass with `@modelcontextprotocol/conformance` `0.2.0-alpha.11`; the frozen `2026-07-28` manifest lists 69 required scenarios (37 server and 32 client).
- `bash -n scripts/run-conformance.sh`: pass. The focused runner test also passed required-input, frozen-argument, token non-disclosure, child cleanup, and failure-propagation checks.
- `git diff --check`, Bun-only lockfile, active-v1-import, rollback/deletion, secret/placeholder, MCP Apps, preview-command, and live-resource-description scans: pass. Historical 4.0 language remains only in the inactive rollback class.

## Honest pending work

Modern MRTR has deterministic unit coverage, but it has not been executed through Workerd, authenticated generic conformance, or a real preview client. Authenticated MCP conformance, the generic authorization runner, preview deployment/DNS/tails, Claude and Codex acceptance, and production deployment also remain pending. They require separately approved infrastructure, secrets, and an operator-obtained short-lived Provider token. No credential was generated, read, stored, or recorded, and no external mutation occurred.

DONE
