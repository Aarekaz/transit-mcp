# MCP 2026-07-28 verification record

Date: 2026-08-13 (America/New_York)

Release candidate: Metro MCP `5.0.0`

Protocol revision: MCP `2026-07-28`

This record separates locally executed evidence from checks that require explicit authorization, a deployed preview, and an operator-obtained short-lived Provider token. No access token, refresh token, authorization code, client secret, GitHub token, raw OAuth props, request body, or MRTR response is recorded here.

## Pinned toolchain

| Component | Version |
| --- | --- |
| Bun | `1.3.14` |
| Wrangler | `4.122.0` |
| Vitest | `4.1.10` |
| Agents | `0.20.1` |
| MCP SDK v2 server/client | `2.0.0` / `2.0.0` |
| MCP SDK v1 rollback peer | `1.30.0` |
| Workers OAuth Provider | `0.10.3` |
| MCP conformance | `0.2.0-alpha.11` |
| Zod | `4.4.3` |

## Executed automated evidence

All commands below completed successfully from the feature worktree on 2026-08-13.

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass: 421 installs checked across 521 packages; no lockfile change |
| `bun run type-check` | Pass: source and test TypeScript programs |
| `bun run test:unit` | Pass: 25 files, 333 tests |
| `bun run test:workers` | Pass: 2 files, 25 tests in Workerd |
| `bun run test` | Pass: 333 unit and 25 Workerd tests in the final combined gate |
| production Wrangler dry-run | Pass: bundle generated in a fresh `/tmp/metro-mcp-task13-production.*` directory; no upload |
| preview Wrangler dry-run | Pass: bundle generated in a fresh `/tmp/metro-mcp-task13-preview.*` directory; no upload |
| conformance requirements pin | Pass: frozen `2026-07-28` manifest lists 69 required scenarios (37 server, 32 client) |
| conformance proxy focused tests | Pass: 8 tests covering target admission, bearer replacement, method/body/header/path/query forwarding, health, manual redirects, and redacted failures |
| conformance runner focused tests | Pass: 4 tests covering Bash syntax, required inputs, frozen CLI arguments, lifecycle cleanup, failure propagation, and token non-disclosure |
| loopback lifecycle probe | Pass: bound `127.0.0.1`, injected a dummy bearer, preserved `/mcp?probe=1`, returned 200, and stopped both local servers |

Wrangler dry-runs reported only `OAUTH_KV`, static assets, and public environment variables. Production and preview reported distinct OAuth KV namespace IDs, origins, callbacks, and GitHub client IDs. Neither dry-run deployed a Worker.

The Workerd suite is the deterministic Metro-specific OAuth gate. It covers discovery, CIMD/DCR boundaries, PKCE, RFC 9207 issuer behavior, RFC 8707 resource binding, explicit consent, Provider props, refresh rotation, revocation, expiry, query-token rejection, and the legacy-token cutoff. It also covers MCP 2026 request metadata, ordinary 2025 stateless compatibility (including ambiguous-station retry guidance), exact 13/3/3 discovery, progress ordering, cancellation, cache hints, Host/Origin policy, and `/sse` alias behavior. Modern `input_required` MRTR and its signed-state boundaries are covered by the unit suite; modern MRTR in Workerd, authenticated conformance, and real clients remains pending.

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

The authenticated server runner accepts a token only through its process environment. Obtain a short-lived token through an approved local or preview Provider flow, then run:

```bash
export MCP_CONFORMANCE_TARGET_URL=https://metro-mcp-preview.anuragd.me/mcp
export MCP_CONFORMANCE_ALLOW_REMOTE=1
read -rsp 'Short-lived MCP token: ' MCP_CONFORMANCE_TOKEN && export MCP_CONFORMANCE_TOKEN
./scripts/run-conformance.sh
unset MCP_CONFORMANCE_TOKEN
```

The proxy rejects remote targets unless `MCP_CONFORMANCE_ALLOW_REMOTE=1` is explicit, binds only `127.0.0.1`, strips inbound Authorization, injects the environment token, and does not put that token in process arguments or its own output.

After an issuer is separately approved, run the authorization-server suite with its loopback callback:

```bash
bunx @modelcontextprotocol/conformance authorization \
  --url "$MCP_CONFORMANCE_AUTH_ISSUER"
```

Add `--client-id` and `--client-secret` only for an explicitly pre-registered test client, and never persist or record that secret.

## Approval-gated checks: pending

These checks have not been run and are not claimed as passing:

- Authenticated MCP server conformance against a deployed preview. Pending preview secrets, DNS/route, deployment approval, and a short-lived Provider token.
- Modern MRTR through Workerd and a real authenticated preview client. Its unit coverage passes, but no Workerd or live execution is claimed.
- The generic authorization-server runner against an approved local or preview issuer. Pending an approved issuer and OAuth test-client conditions.
- Claude acceptance: discovery, GitHub login, consent, refresh, exact tools list, DC and NYC calls, one prompt, one resource, MRTR, progress, `/sse` automatic/Streamable HTTP alias, and forced legacy-SSE failure.
- Codex acceptance with the same behavioral matrix.
- Preview Worker-tail confirmation that no credential is logged and no request addresses `MCP_SESSION`.
- Production deployment. This remains a separate explicit action after PR review.

When approved, record client and runner versions, date, scenario counts, and redacted evidence in this section. Do not paste credentials, callback codes, raw props, bodies, or MRTR form contents.

## Rollback checks

- `MetroMcpAgent` remains exported as an inactive rollback asset.
- The original `v1` `new_sqlite_classes` migration remains unchanged.
- There is no Durable Object deletion migration.
- Rollback restores the prior version and its prior bindings; it does not delete the namespace.
- MCP Apps remain deferred to the next PR.
