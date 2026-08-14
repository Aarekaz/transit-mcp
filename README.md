# 🚇 Metro MCP

> Model Context Protocol Server for US Transit Systems (DC Metro & NYC Subway)

[![MCP](https://img.shields.io/badge/MCP-2026--07--28-blue)](https://modelcontextprotocol.io)
[![Metro MCP](https://img.shields.io/badge/Metro_MCP-5.0.0-0f766e)](CHANGELOG.md)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)
[![OAuth 2.1](https://img.shields.io/badge/OAuth-2.1%20%2B%20PKCE-green)](https://oauth.net/2.1/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

A unified remote Model Context Protocol (MCP) server supporting multiple US transit systems. Currently supports Washington DC Metro (WMATA) and New York City Subway (MTA). Built for seamless integration with MCP-compatible clients like Claude Desktop, Cursor, Codex, and any client that supports Streamable HTTP MCP servers.

**Quick Links:** [Quick Start](#quick-start) • [What You Can Do](#what-you-can-do) • [Deployment](#deployment) • [Client Integration](#mcp-client-integration)

---

## What You Can Do

Ask natural language questions about DC Metro or NYC Subway in Claude Desktop or any MCP-compatible client:

### 🚆 Real-Time Transit Information

**Washington DC:**

- *"When is the next Red Line train at Dupont Circle?"*
- *"What bus routes are available?"*
- *"Find bus stops near Dupont Circle"*
- *"Where are all the 30N buses right now?"*
- *"When is the next bus at stop 1001195?"*
- *"Show me all trains currently running on the Metro system"*
- *"Are there any delays on the Blue Line right now?"*
- *"Are all the elevators working at Union Station?"*

**New York City:**

- *"When is the next 1 train at Times Square?"*
- *"Are there delays on the A/C line?"*
- *"What trains are arriving at Grand Central?"*
- *"What is the A train and where does it go?"*
- *"What nearby stations can I walk to from Times Square?"*
- *"How long does it take to walk between Times Square platforms?"*

### 🗺️ Station Information & Navigation

**Washington DC:**

- *"Where is the Smithsonian Metro station?"*
- *"Show me all the stations on the Green Line"*

**New York City:**

- *"Where is the Union Square station?"*
- *"Show me all 496 stations on the NYC Subway"*
- *"Which stations connect to Times Square?"*
- *"Explain the difference between express and local trains"*

### ♿ Accessibility

**Washington DC (Elevator Outages):**

- *"Are there any elevator outages between here and National Airport?"*
- *"Which DC Metro stations have working elevators right now?"*

### 🔔 Service Monitoring

**Both Cities:**

- *"Any transit delays right now in NYC?"*
- *"Is the DC Metro Orange Line running normally?"*
- *"Compare service quality between DC Metro and NYC Subway"*

### 📊 System Information

**Washington DC:**

- Complete list of all Metro stations with coordinates
- Information about all six Metro lines (Red, Blue, Orange, Silver, Green, Yellow)

**New York City:**

- **Complete coverage:** All 496 NYC Subway stations with coordinates
- **Transfer information:** Walk times between connected stations (87 stations with transfers)
- **Route descriptions:** Detailed service patterns for all 29 routes (express vs local, operating hours)
- **Platform clarity:** Explains directional platforms (e.g., "127N" = northbound at Times Square)

---

## Quick Start

### Using the Public Server

The fastest way to get started is to use the hosted instance:

1. Open your MCP Client
2. Add this URL: `https://metro-mcp.anuragd.me/mcp`
3. Click "Connect" and authorize via GitHub
4. Start asking questions about DC Metro or NYC Subway

### Deploy Your Own

Want to run your own instance? See the [Deployment](#deployment) section below.

---

## Deployment

### Prerequisites

- [WMATA API Key](https://developer.wmata.com/) (required)
- [Cloudflare Account](https://dash.cloudflare.com/) (free tier works)
- [Bun](https://bun.sh/) for package management
- [Node.js](https://nodejs.org/) for Wrangler and the Workerd Vitest pool; Bun remains the sole package manager and lockfile owner
- [GitHub OAuth App](https://github.com/settings/developers) (for authentication)

### Environment setup

Install exactly what `bun.lock` records:

```bash
bun install --frozen-lockfile
```

Create one OAuth Provider namespace for each deployed environment and put its ID in the corresponding `OAUTH_KV` binding:

```bash
bunx wrangler kv namespace create OAUTH_KV
bunx wrangler kv namespace create OAUTH_KV_preview
```

Production and preview must also use distinct GitHub OAuth apps. Configure each callback as `${MCP_PUBLIC_ORIGIN}/callback`; never reuse the production app or OAuth KV for preview. Each environment sets:

- `MCP_PUBLIC_ORIGIN`, `MCP_ALLOWED_HOSTNAMES`, and `MCP_ALLOWED_ORIGIN_HOSTNAMES`
- `OAUTH_REDIRECT_URI` and the environment's public GitHub `GITHUB_CLIENT_ID`
- `ENVIRONMENT` (`production`, `preview`, or `development`)
- `OAUTH_KV`, pointing at the environment's dedicated namespace

Set production secrets interactively. `MCP_REQUEST_STATE_KEY` is a stable, environment-specific 32-byte-or-longer key used only for signed MRTR state. `JWT_SECRET` remains temporarily for the legacy `/mcp`-audience bridge.

```bash
bunx wrangler secret put MCP_REQUEST_STATE_KEY
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put WMATA_API_KEY
bunx wrangler secret put JWT_SECRET
```

Set the same four secret names independently for preview; named Wrangler environments do not inherit production secrets:

```bash
bunx wrangler secret put MCP_REQUEST_STATE_KEY --env preview
bunx wrangler secret put GITHUB_CLIENT_SECRET --env preview
bunx wrangler secret put WMATA_API_KEY --env preview
bunx wrangler secret put JWT_SECRET --env preview
```

Wrangler must include both `nodejs_compat` and `global_fetch_strictly_public`. Validate both shapes before any approved deployment:

```bash
bunx wrangler deploy --dry-run --outdir /tmp/metro-mcp-production
bunx wrangler deploy --dry-run --env preview --outdir /tmp/metro-mcp-preview
```

## MCP Client Integration

### Claude

Use the canonical Streamable HTTP endpoint in Claude Code:

```bash
claude mcp add --transport http metro-mcp https://metro-mcp.anuragd.me/mcp
```

Then open `/mcp`, select `metro-mcp`, and complete GitHub login and consent. Claude.ai/Desktop users can add the same URL as a remote custom connector where their plan and workspace policy permit it.

### Codex

```bash
codex mcp add metro-mcp --url https://metro-mcp.anuragd.me/mcp
codex mcp login metro-mcp --scopes transit:read
```

The checked-in [`mcp-config.json`](mcp-config.json) shows the equivalent generic remote-HTTP configuration. Access and refresh tokens stay in the client's credential store; do not paste them into project configuration.

### Transport compatibility

- MCP `2026-07-28` requests are stateless and do not require `initialize`.
- Ordinary tools, resources, and prompts remain available to MCP 2025 stateless clients.
- `POST /sse` and `OPTIONS /sse` are URL aliases rewritten to canonical `/mcp` before authorization.
- Legacy HTTP+SSE is removed. `GET` and `DELETE` on `/sse` or `/mcp`, session message URLs, and `/sse/` return `405`.
- OAuth audience and discovery always use `https://metro-mcp.anuragd.me/mcp`; `/sse` is never an OAuth resource.

## OAuth Endpoints

The Workers OAuth Provider implements OAuth 2.1 with PKCE:

- Discovery: `/.well-known/oauth-authorization-server`
- Registration: CIMD first, with `/register` as a temporary Dynamic Client Registration fallback
- Authorization: `/authorize` (GitHub OAuth integration)
- Token: `/token` (Authorization code exchange with PKCE verification)
- Callback: `/callback` (GitHub OAuth callback)

Clients receive an explicit `transit:read` consent screen. Grants are bound to the canonical `/mcp` resource; access tokens last at most 60 minutes, refresh tokens last at most 30 days and rotate on use, and bearer tokens are accepted only in the `Authorization` header. The DCR fallback sunsets on **2027-06-30**.

Version 5.0 requires reauthorization for tokens without an audience, tokens bound to `/sse`, and clients registered in the old DCR store. Existing compatible legacy JWTs bound to `/mcp` stop working at the earlier of their embedded expiry and **2026-11-30T00:00:00Z**.

## Supported Cities

The server currently supports these transit systems:

| City | System | Real-Time Data | Service Alerts | Elevator Status |
| ---- | ------ | -------------- | -------------- | --------------- |
| **Washington DC** | WMATA (Metro) | ✅ | ✅ | ✅ |
| **New York City** | MTA (Subway) | ✅ | ✅ | ❌ |

## Available MCP Tools

The server exposes the following tools through the MCP protocol:

| Tool | Description | Supported Cities |
| ---- | ----------- | ---------------- |
| `get_station_predictions` | Get real-time train arrival predictions for a station | DC, NYC |
| `search_stations` | Search for stations by name or code | DC, NYC |
| `get_stations_by_line` | Get all stations on a specific line | DC, NYC |
| `get_incidents` | Check current service disruptions and advisories | DC, NYC |
| `get_all_stations` | Get a complete list of all stations with coordinates | DC, NYC |
| **`get_station_transfers`** 🆕 | **Get transfer connections and walk times between nearby stations** | **NYC only** |
| **`get_route_info`** 🆕 | **Get detailed route information (express/local, service patterns, hours)** | **NYC only** |
| `get_elevator_incidents` | Find elevator and escalator outages | DC only |
| `get_bus_predictions` | Get real-time bus arrival predictions (7-digit stop ID) | DC only |
| `get_bus_routes` | Get list of all available bus routes | DC only |
| `get_bus_stops` | Search bus stops by location or get all stops | DC only |
| `get_bus_positions` | Get live positions of all buses (optionally filter by route) | DC only |
| `get_train_positions` | Get live positions of all trains on the system | DC only |

**Total: 13 MCP tools** (11 core + 2 new NYC-specific tools)

## Technical Details

### MCP Protocol

- **Version:** MCP `2026-07-28`, with ordinary MCP 2025 stateless compatibility
- **Transport:** Stateless Streamable HTTP through a fresh SDK v2 server for each request. JSON and request-scoped SSE responses are supported; protocol sessions, resumability, and server push are not advertised.
- **Authentication:** The Cloudflare Workers OAuth Provider owns discovery, CIMD/DCR validation, PKCE, RFC 9207 issuer identifiers, RFC 8707 resource binding, RFC 9728 protected-resource metadata, refresh rotation, revocation, and Provider token storage.
- **Tool result shape:** Every tool emits `structuredContent` (typed object matching `outputSchema`) alongside the legacy `content[0].text` (serialized JSON) for backwards compatibility.
- **Tool annotations:** Every tool declares `readOnlyHint`, `idempotentHint`, `openWorldHint` so clients can render safe-action affordances.
- **Capabilities exposed:**
  - `tools` — 13 transit query tools (DC + NYC)
  - `resources` — three `transit://` URI templates (stations, routes, incidents)
  - `prompts` — three canned templates (service-briefing, commute-planner, accessibility-check)
  - MRTR input — modern clients receive `input_required` for ambiguous stations; MCP 2025 clients receive deterministic retry guidance with exact station IDs
  - Progress notifications: emitted for `get_all_stations` when the client opts in via `params._meta.progressToken`

### Transit APIs

**WMATA (DC Metro):**

The server interfaces with the official WMATA REST APIs. Visit [WMATA's developer documentation](https://developer.wmata.com/) for details:

- **Station predictions:** Real-time train arrival information
- **Station information:** Station names, codes, and locations
- **Incidents:** Service disruptions and advisories
- **Elevator/escalator outages:** Accessibility information

**MTA (NYC Subway):**

The server uses GTFS-Realtime feeds from the MTA. Public API endpoints (no API key required):

- **Real-time feeds:** Protocol Buffers format with 30-second update intervals
- **8 separate feeds:** Covering all subway lines (1-7, A/C/E, B/D/F/M, etc.)
- **NYCT extensions:** Train IDs, track assignments, and direction information
- **Service alerts:** Embedded in GTFS-Realtime alert entities

### Hosting

- **Platform:** Cloudflare Workers
- **Static assets:** `public/` is deployed through Cloudflare Workers Static Assets and bound as `env.ASSETS`; the Worker serves API/OAuth/MCP routes first, then delegates landing-page, docs, image, and icon requests to the assets binding.
- **Storage:**
  - Environment-specific Cloudflare KV `OAUTH_KV` — OAuth Provider grants, tokens, and registrations
  - No active protocol-session storage. The old `MetroMcpAgent` export and original `v1` migration remain inactive solely for rollback.
- **Runtime:** V8 isolates with global edge deployment

### Source Structure

The codebase is organized for multi-city transit support with a clean separation of concerns:

```text
src/
├── index.ts              # Outer route normalization and Provider composition
├── public-handler.ts     # /info, OAuth UI, and static assets
├── route-normalizer.ts   # Exact /mcp admission and /sse URL alias
├── oauth/                # Provider configuration, GitHub consent, legacy bridge
├── mcp/                  # Stateless server factory, tools, resources, and prompts
├── mcp-agent.ts          # Inactive 4.x rollback class only
└── transit/              # WMATA and MTA clients with request cancellation
```

**Key Architecture Decisions:**

- **Transit Abstraction:** Common `TransitAPIClient` interface enables easy addition of new cities (BART, MBTA, etc.)
- **City Routing:** Single server handles all cities via `city` parameter in MCP tool calls
- **Normalized Responses:** All transit clients return standardized `TransitStation`, `TransitPrediction`, and `TransitIncident` types
- **Extensibility:** Adding a new city only requires implementing the abstract client class

## Verification and rollback

Run the complete local suite with `bun run test`. The authenticated conformance runner requires an operator-obtained short-lived Provider access token in the process environment; it never stores the token or puts it in command arguments:

```bash
export MCP_CONFORMANCE_TARGET_URL=https://metro-mcp-preview.anuragd.me/mcp
export MCP_CONFORMANCE_ALLOW_REMOTE=1
read -rsp 'Short-lived MCP token: ' MCP_CONFORMANCE_TOKEN && export MCP_CONFORMANCE_TOKEN
./scripts/run-conformance.sh
unset MCP_CONFORMANCE_TOKEN
```

See [`docs/mcp-2026-verification.md`](docs/mcp-2026-verification.md) for the automated and approval-gated acceptance record.

Rollback restores the prior Worker version and its prior bindings. Do not delete the original `MetroMcpAgent` Durable Object namespace or add a deletion migration during the stabilization window; protocol session state is disposable, but retaining the class and original `v1` migration keeps rollback possible.

MCP Apps and embedded interactive UI are intentionally deferred to the next PR.

## Contributing

Contributions are welcome! Feel free to:

- Report bugs or request features via [GitHub Issues](https://github.com/Aarekaz/metro-mcp/issues)
- Submit pull requests with improvements
- Share feedback on the MCP implementation

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

Built with ❤️ for the Washington DC Metro community
