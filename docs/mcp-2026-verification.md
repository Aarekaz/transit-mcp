# MCP 2026-07-28 verification record

Date: 2026-08-17 (America/New_York)

Release candidate: Metro MCP `5.0.0`

Protocol revision: MCP `2026-07-28`

This record separates automated evidence, deployed acceptance, and the checks that remain pending. No access token, refresh token, authorization code, client secret, GitHub token, raw OAuth props, request body, or MRTR response is recorded here.

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

All commands below completed successfully from the feature worktree on 2026-08-17.

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Pass: 421 installs checked across 521 packages; no lockfile change |
| `bun run type-check` | Pass: source and test TypeScript programs |
| `bun run test:unit` | Pass: 25 files, 342 tests |
| `bun run test:workers` | Pass: 2 files, 25 tests in Workerd |
| `bun run test` | Pass: 342 unit and 25 Workerd tests in the final combined gate |
| `bun run build` | Pass: the project intentionally has no separate build step; Wrangler owns the production bundle |
| production Wrangler dry-run | Pass: 1,788.21 KiB / 432.66 KiB gzip bundle generated in a fresh `/tmp/metro-prod-dryrun.*` directory; no upload |
| preview Wrangler dry-run | Pass: 1,788.21 KiB / 432.66 KiB gzip bundle generated in a fresh `/tmp/metro-preview-dryrun.*` directory; no upload |
| conformance requirements pin | Pass: frozen `2026-07-28` manifest lists 69 required scenarios (37 server, 32 client) |
| conformance proxy focused tests | Pass: 8 tests covering target admission, bearer replacement, method/body/header/path/query forwarding, health, manual redirects, and redacted failures |
| conformance runner focused tests | Pass: 4 tests covering Bash syntax, required inputs, frozen CLI arguments, lifecycle cleanup, failure propagation, and token non-disclosure |
| loopback lifecycle probe | Pass: bound `127.0.0.1`, injected a dummy bearer, preserved `/mcp?probe=1`, returned 200, and stopped both local servers |

Wrangler dry-runs reported only `OAUTH_KV`, static assets, and public environment variables. Production and preview reported distinct OAuth KV namespace IDs, origins, callbacks, and GitHub client IDs. Neither dry-run deployed a Worker.

The Workerd suite is the deterministic Metro-specific OAuth gate. It covers discovery, CIMD/DCR boundaries, PKCE, RFC 9207 issuer behavior, RFC 8707 resource binding, explicit consent, Provider props, refresh rotation, revocation, expiry, query-token rejection, and the legacy-token cutoff. It also covers MCP 2026 request metadata, ordinary 2025 stateless compatibility (including ambiguous-station retry guidance), exact 13/3/3 discovery, progress ordering, cancellation, cache hints, Host/Origin policy, and `/sse` alias behavior. Modern `input_required` MRTR and its signed-state boundaries are covered by the unit suite; successful modern MRTR flows passed both live edge probes. A dedicated modern-MRTR Workerd scenario remains pending.

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

## Deployed acceptance evidence

Production was promoted only after explicit operator approval. The preview and production probes used short-lived credentials kept outside the repository and revoked their active token families at the end.

| Environment | Deployed version | Result |
| --- | --- | --- |
| Preview | `7567149c-fa04-43e5-a813-314b827ba6fc` at `https://metro-mcp-preview.anuragd.me` | Pass |
| Production | `7251f0b3-fdbb-4d8c-b42a-631d23f13b3c` at `https://metro-mcp.anuragd.me` | Pass |

The production rollback target recorded before promotion is `52d55a93-8040-4d87-abd7-b169968541eb`.

Both deployed environments passed the same real-edge matrix:

- Public `/info`, OAuth authorization-server discovery, and RFC 9728 protected-resource metadata report Metro MCP `5.0.0`, protocol `2026-07-28`, and the environment's canonical `/mcp` resource.
- DCR, S256 PKCE, GitHub authentication, explicit Metro consent, RFC 9207 issuer validation, RFC 8707 resource binding, access-token exchange, refresh rotation, and token-family revocation.
- MCP 2026 discovery without `initialize`, with the exact ordered 13 tools, 3 resources, and 3 prompts.
- Live WMATA and MTA prediction calls, a resource read, a prompt render, SSE progress ordering, modern signed-state MRTR, 2025 stateless compatibility, and the `/sse` POST alias.
- Method/session path boundaries and rejection of query-string credentials.

Native Codex `0.148.0-alpha.9` acceptance passed against both environments. The client completed its own OAuth login and consent and made live DC `A01` and NYC `127` tool calls. Preview additionally verified exact tool discovery and a live resource read. The temporary MCP entries and locally stored Codex credentials were logged out and removed afterward; Provider DCR records expire under the configured registration TTL. With this client build, the working setup was server discovery followed by explicit `codex mcp login ... --scopes transit:read --oauth-client-registration dcr`; redundantly forcing the resource parameter caused the client to duplicate it and was correctly rejected by the server.

Claude acceptance was intentionally skipped at the operator's direction; Codex was used as the real MCP client instead. Worker tails were used only while diagnosing a transient GitHub identity `503`; temporary diagnostics were removed after the bounded-retry fix. No final tail-wide credential-string scan is claimed.

## Checks still pending

These checks have not been run and are not claimed as passing:

- The official authenticated MCP server conformance runner against a deployed environment. The frozen 69-scenario manifest is pinned, but the full runner is not claimed as green.
- The generic authorization-server conformance runner against the deployed issuer.
- A dedicated modern-MRTR Workerd scenario; unit and real-edge MRTR coverage pass.
- A final Worker-tail scan for credential values and `MCP_SESSION` access.

Do not paste credentials, callback codes, raw props, bodies, or MRTR form contents when completing those checks.

## Rollback checks

- `MetroMcpAgent` remains exported as an inactive rollback asset.
- The original `v1` `new_sqlite_classes` migration remains unchanged.
- There is no Durable Object deletion migration.
- Rollback restores the prior version and its prior bindings; it does not delete the namespace.
- MCP Apps remain deferred to the next PR.
