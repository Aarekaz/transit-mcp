# 🚇 Metro MCP

> Model Context Protocol Server for US Transit Systems (DC Metro & NYC Subway)

[![MCP](https://img.shields.io/badge/MCP-2025--03--26-blue)](https://modelcontextprotocol.io)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)
[![OAuth 2.1](https://img.shields.io/badge/OAuth-2.1%20%2B%20PKCE-green)](https://oauth.net/2.1/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

A unified remote Model Context Protocol (MCP) server supporting multiple US transit systems. Currently supports Washington DC Metro (WMATA) and New York City Subway (MTA). Built for seamless integration with MCP-compatible clients like Claude Desktop.

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

### 🗺️ Station Information & Navigation

**Washington DC:**

- *"Where is the Smithsonian Metro station?"*
- *"Show me all the stations on the Green Line"*
- *"How do I get from Capitol South to Bethesda?"*

**New York City:**

- *"Where is the Union Square station?"*
- *"Show me all stations on the 4/5/6 lines"*
- *"How do I get from Penn Station to Brooklyn?"*

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

- Key NYC Subway stations with coordinates
- Information about all subway lines (numbered and lettered)

---

## Quick Start

### Using the Public Server

The fastest way to get started is to use the hosted instance:

1. Open Claude Desktop
2. Add this URL: `https://metro-mcp.aarekaz.workers.dev`
3. Click "Connect" and authorize via GitHub
4. Start asking questions about DC Metro!

### Deploy Your Own

Want to run your own instance? See the [Deployment](#deployment) section below.

---

## Deployment

### Prerequisites

- [WMATA API Key](https://developer.wmata.com/) (required)
- [Cloudflare Account](https://dash.cloudflare.com/) (free tier works)
- [Bun](https://bun.sh/) or Node.js installed
- [GitHub OAuth App](https://github.com/settings/developers) (for authentication)

### Setup Steps

**1. Install dependencies:**

```bash
# Using Bun (recommended)
bun install

# Or using npm
npm install
```

**2. Generate JWT secret:**

```bash
openssl rand -hex 32
```

**3. Create GitHub OAuth App:**

- Go to [github.com/settings/developers](https://github.com/settings/developers)
- Click "New OAuth App"
- Set **Homepage URL**: `https://metro-mcp.your-subdomain.workers.dev`
- Set **Authorization callback URL**: `https://metro-mcp.your-subdomain.workers.dev/callback`
- Save the **Client ID** and **Client Secret**

**4. Create KV Namespaces:**

```bash
# Create OAuth storage namespace
bunx wrangler kv namespace create "OAUTH_CLIENTS"
bunx wrangler kv namespace create "OAUTH_CLIENTS" --preview

# Create rate limiting namespace
bunx wrangler kv namespace create "RATE_LIMIT_KV"
bunx wrangler kv namespace create "RATE_LIMIT_KV" --preview
```

Copy the IDs from the output and update `wrangler.toml`.

**5. Configure environment:**

Copy the example files and fill in your values:

```bash
# Copy wrangler config
cp wrangler.toml.example wrangler.toml
# Update the KV namespace IDs in wrangler.toml

# Copy local development secrets
cp .dev.vars.example .dev.vars
# Add your actual secrets to .dev.vars
```

**6. Set production secrets:**

```bash
# These are encrypted and stored securely by Cloudflare
bunx wrangler secret put WMATA_API_KEY
bunx wrangler secret put GITHUB_CLIENT_SECRET
bunx wrangler secret put JWT_SECRET
```

**7. Deploy:**

```bash
# Deploy to Cloudflare Workers
bunx wrangler deploy
```

## MCP Client Integration

### Claude Desktop (Automatic OAuth)

**Simple Setup:**

Just add the server URL to Claude Desktop:

```text
https://metro-mcp.aarekaz.workers.dev
```

Claude Desktop will automatically:

1. Discover OAuth endpoints via `/.well-known/oauth-authorization-server`
2. Register as a client
3. Open your browser for GitHub authentication
4. Receive and store the access token
5. Connect to the MCP server

**No manual token copying required!**

### Other MCP Clients

For MCP clients that support OAuth 2.1 with automatic discovery:

**Server URL:**

```text
https://metro-mcp.aarekaz.workers.dev
```

The client will handle authentication automatically via the OAuth flow.

### Manual Token Authentication (Legacy)

If your MCP client doesn't support OAuth, you can still authenticate manually:

1. Visit `https://metro-mcp.aarekaz.workers.dev/authorize` in your browser
2. Authorize via GitHub
3. Copy the JWT token displayed
4. Configure your client with:
   - Server URL: `https://metro-mcp.aarekaz.workers.dev/sse`
   - Authorization Header: `Bearer your-jwt-token-here`

## OAuth Endpoints

The server implements OAuth 2.1 with PKCE for secure authentication:

- Discovery: `/.well-known/oauth-authorization-server`
- Registration: `/register` (Dynamic client registration - RFC 7591)
- Authorization: `/authorize` (GitHub OAuth integration)
- Token: `/token` (Authorization code exchange with PKCE verification)
- Callback: `/callback` (GitHub OAuth callback)

### Security Features

- PKCE (S256) required for all authorization flows
- Persistent client registration via Cloudflare KV
- JWT tokens with 90-day expiration
- Rate limiting and origin validation

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
| `get_elevator_incidents` | Find elevator and escalator outages | DC only |
| `get_all_stations` | Get a complete list of all stations with coordinates | DC, NYC |
| `get_bus_predictions` | Get real-time bus arrival predictions (7-digit stop ID) | DC only |
| `get_bus_routes` | Get list of all available bus routes | DC only |
| `get_bus_stops` | Search bus stops by location or get all stops | DC only |
| `get_bus_positions` | Get live positions of all buses (optionally filter by route) | DC only |
| `get_train_positions` | Get live positions of all trains on the system | DC only |

**Note:** Most tools require a `city` parameter (`dc` or `nyc`). DC-only tools (`get_bus_predictions`, `get_bus_routes`, `get_bus_stops`, `get_bus_positions`, `get_train_positions`, `get_elevator_incidents`) do not require the city parameter.

## Technical Details

### MCP Protocol

- **Version:** 2025-03-26
- **Transport:** SSE (Server-Sent Events)
- **Authentication:** OAuth 2.1 with PKCE (S256)

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
- **Storage:** Cloudflare KV (for OAuth client registration)
- **Runtime:** V8 isolates with global edge deployment

### Source Structure

The codebase is organized for multi-city transit support with a clean separation of concerns:

```text
src/
├── index.ts              # Cloudflare Worker entry point
├── router.ts             # Request routing (OAuth, MCP, API endpoints)
├── types.ts              # Shared TypeScript type definitions
│
├── OAuth & Authentication
│   ├── auth.ts           # JWT token management and verification
│   └── oauth-handler.ts  # OAuth 2.1 flow implementation with PKCE
│
├── MCP Protocol
│   ├── mcp-handler.ts    # MCP request processing and tool routing
│   ├── mcp-tools.ts      # MCP tool definitions (11 tools)
│   └── mcp-types.ts      # MCP protocol type definitions
│
├── Error Handling
│   └── error-handler.ts  # Multi-city validation and error handling
│
└── Transit Abstraction Layer
    ├── base.ts           # Abstract TransitAPIClient class
    ├── registry.ts       # Transit client factory (city routing)
    ├── wmata-client.ts   # DC Metro client (WMATA REST APIs)
    └── mta-client.ts     # NYC Subway client (GTFS-Realtime)
```

**Key Architecture Decisions:**

- **Transit Abstraction:** Common `TransitAPIClient` interface enables easy addition of new cities (BART, MBTA, etc.)
- **City Routing:** Single server handles all cities via `city` parameter in MCP tool calls
- **Normalized Responses:** All transit clients return standardized `TransitStation`, `TransitPrediction`, and `TransitIncident` types
- **Extensibility:** Adding a new city only requires implementing the abstract client class

## Contributing

Contributions are welcome! Feel free to:

- Report bugs or request features via [GitHub Issues](https://github.com/yourusername/metro-mcp/issues)
- Submit pull requests with improvements
- Share feedback on the MCP implementation

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

Built with ❤️ for the Washington DC Metro community
