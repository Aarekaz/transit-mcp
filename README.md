# Metro MCP

Metro MCP is an anonymous, read-only Model Context Protocol server for live DC Metro and NYC Subway information.

[![MCP](https://img.shields.io/badge/MCP-2026--07--28-blue)](https://modelcontextprotocol.io)
[![Metro MCP](https://img.shields.io/badge/Metro_MCP-6.0.0-0f766e)](CHANGELOG.md)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## Connect

The production endpoint is `https://metro-mcp.anuragd.me/mcp`. No login is required. No client credentials, bearer token, or OAuth flow is required; Metro MCP does not collect client credentials. Stale `Authorization` headers are ignored.

### Claude

```bash
claude mcp add --transport http metro-mcp https://metro-mcp.anuragd.me/mcp
```

### Codex

```bash
codex mcp add metro-mcp https://metro-mcp.anuragd.me/mcp
```

### Generic Streamable HTTP client

```json
{
  "mcpServers": {
    "metro-mcp": {
      "type": "http",
      "url": "https://metro-mcp.anuragd.me/mcp"
    }
  }
}
```

`POST /mcp` is the recommended stateless Streamable HTTP endpoint. `POST` and `OPTIONS /sse` are a compatibility alias; legacy GET SSE, DELETE, session-message URLs, and slash variants return `405`.

## What it provides

Metro MCP exposes 13 MCP tools across WMATA and MTA data, including arrivals, service incidents, stations, elevator outages, bus operations, train positions, transfer detail, and route information.

It also provides three `transit://` URI templates (stations, routes, and incidents) and three canned templates (`service-briefing`, `commute-planner`, and `accessibility-check`). Tool calls are read-only, idempotent, and open-world. Every result includes typed `structuredContent` and a JSON text fallback.

An Apps-capable host can render the Transit Board resource for all 13 tools. Clients without Apps support receive the same text fallback and structured result; the Apps enhancement does not alter a transit call. See [the Apps verification record](docs/mcp-apps-verification.md).

## Runtime and safety boundaries

- **Protocol:** MCP `2026-07-28` stateless Streamable HTTP. The server does not advertise sessions, resumability, or server push.
- **Request trust:** public origin and host/origin allowlists are validated at startup. The signed MRTR request-state codec is bound to the MCP method and expires after five minutes.
- **Cancellation:** client disconnects propagate request cancellation to MCP handlers and upstream transit fetches.
- **Caching:** discovery and tool metadata are publicly cacheable for 24 hours. Station and route resources are public-cacheable; live incident resources are not. WMATA uses Cloudflare edge cache windows appropriate to each feed, while MTA real-time feeds use a 30-second in-memory cache.
- **Rate limiting:** roughly 300 requests per 60-second window per source-IP key per Cloudflare location. Shared egress IPs group clients, and enforcement is eventually consistent. This is abuse protection, not a dedicated user quota.
- **Rollback:** the inactive `MetroMcpAgent` class and original `v1` Durable Object migration remain for rollback. Do not add a deletion migration during stabilization.

## Deploy your own

Client access is anonymous. A self-hosted Worker still needs its own WMATA API key and a stable `MCP_REQUEST_STATE_KEY` of at least 32 bytes for signed MRTR state.

```bash
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bun run dev
```

Use the checked-in loopback origin, hostname allowlists, and `ENVIRONMENT=development` values together. Keep `.dev.vars` out of source control. Production and preview use their own origins, allowlists, state keys, WMATA keys, and `MCP_RATE_LIMITER` bindings.

Before an approved deployment, run only dry-runs:

```bash
bunx wrangler deploy --dry-run --outdir /tmp/metro-mcp-production
bunx wrangler deploy --env preview --dry-run --outdir /tmp/metro-mcp-preview
```

## Verification

Run the suite with `bun run test`. The direct conformance runner requires only a target URL:

```bash
export MCP_CONFORMANCE_TARGET_URL=https://metro-mcp-preview.anuragd.me/mcp
./scripts/run-conformance.sh
```

See [MCP 2026 verification](docs/mcp-2026-verification.md) for protocol coverage and [security architecture](docs/SECURITY.md) for the public-request and rate-limit boundaries.

## Support and legal

- [Documentation](https://metro-mcp.anuragd.me/docs/)
- [Privacy](https://metro-mcp.anuragd.me/privacy)
- [Terms](https://metro-mcp.anuragd.me/terms)
- [Support](https://metro-mcp.anuragd.me/support)
- [Issues](https://github.com/Aarekaz/metro-mcp/issues)

## License

MIT. See [LICENSE](LICENSE).
