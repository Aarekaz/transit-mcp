# MCP 2026-07-28 verification record

Release candidate: Metro MCP `6.0.0`

Protocol revision: MCP `2026-07-28`

Metro MCP is anonymous: `https://metro-mcp.anuragd.me/mcp` requires no login. No client credentials, bearer token, or OAuth flow is required; stale `Authorization` headers are ignored.

## Pinned toolchain

| Component | Version |
| --- | --- |
| Bun | `1.3.14` |
| Wrangler | `4.122.0` |
| Vitest | `4.1.10` |
| Agents | `0.20.1` |
| MCP SDK v2 server/client | `2.0.0` / `2.0.0` |
| MCP SDK v1 rollback peer | `1.30.0` |
| MCP conformance | `0.2.0-alpha.11` |
| Zod | `4.4.3` |

## Executed automated evidence

Run the following gates from the release worktree. Record fresh output before claiming a result.

| Gate | Result |
| --- | --- |
| frozen install | `bun install --frozen-lockfile` |
| type programs | `bun run type-check` |
| unit and Workerd suites | `bun run test:unit`, `bun run test:workers`, `bun run test` |
| dry-runs | production and preview `wrangler deploy --dry-run` |
| conformance manifest | frozen `2026-07-28` list command |
| direct server conformance | runner with only `MCP_CONFORMANCE_TARGET_URL` |

Dry-runs must show only the current public environment variables, static assets, and `MCP_RATE_LIMITER` binding. They must not deploy a Worker. The deterministic suites cover MCP 2026 request metadata, ordinary 2025 stateless compatibility, exact 13/3/3 discovery, progress ordering, cancellation, cache hints, host/origin policy, signed MRTR state, and `/sse` alias behavior.

## Reproducible local commands

```bash
bun install --frozen-lockfile
bun run type-check
bun run test:unit
bun run test:workers
bun run test

production_out=$(mktemp -d /tmp/metro-mcp-production.XXXXXX)
preview_out=$(mktemp -d /tmp/metro-mcp-preview.XXXXXX)
bunx wrangler deploy --dry-run --outdir "$production_out"
bunx wrangler deploy --dry-run --env preview --outdir "$preview_out"

bunx @modelcontextprotocol/conformance list --requirements 2026-07-28
```

The direct server runner accepts only its target URL:

```bash
export MCP_CONFORMANCE_TARGET_URL=https://metro-mcp-preview.anuragd.me/mcp
./scripts/run-conformance.sh
```

It runs `@modelcontextprotocol/conformance` alpha.11 directly against the supplied URL with frozen `2026-07-28` requirements. No proxy, credential injection, or account flow is involved.

## Deployed acceptance evidence

Production and preview acceptance must use the anonymous public endpoints. Verify `/info` reports version `6.0.0`, protocol `2026-07-28`, endpoint paths `/mcp` and `/sse`, and authentication `{ "type": "none" }`, with no discovery endpoints. Verify an ordinary MCP 2026 discovery plus live DC and NYC tool calls, resource reads, prompt render, progress ordering, signed MRTR state, cancellation, 2025 stateless compatibility, and the `/sse` POST alias.

## Checks still pending

These checks have not been run and are not claimed as passing:

- The direct MCP server conformance runner against a deployed environment.
- A dedicated modern-MRTR Workerd scenario.
- A final Worker-tail scan for sensitive operational values and inactive rollback assets.

Do not paste operational secrets, request bodies, or MRTR form contents when completing those checks.

## Rollback checks

- `MetroMcpAgent` remains exported as an inactive rollback asset.
- The original `v1` `new_sqlite_classes` migration remains unchanged.
- There is no Durable Object deletion migration.
- Rollback restores the prior version and its prior bindings; it does not delete the namespace.
- The existing Transit Board Apps asset and its 13-tool mapping remain in the release.
