# Transit MCP

Transit MCP is a free, anonymous, read-only Model Context Protocol server that lets your AI answer transit questions: how do I get there, when's the next train, is anything broken, where's my bus. It's a side project, and general-purpose agents (ChatGPT, Claude, Muse, Instinct and friends) plug straight into it.

It covers:

- **New York:** the subway, the Long Island Rail Road, Metro-North and NYC buses.
- **Washington DC:** Metrorail and Metrobus.
- **SF Bay Area:** every operator in 511 SF Bay's regional feed, including BART, Muni, Caltrain, AC Transit, VTA, SamTrans and the ferries. Departures, alerts, vehicles and trip planning all work there.

**Metro MCP is now Transit MCP.**

Nearly 100,000 requests served in the last 7 days.

[![MCP](https://img.shields.io/badge/MCP-2026--07--28-blue)](https://modelcontextprotocol.io)
[![Transit MCP](https://img.shields.io/badge/Transit_MCP-6.1.0-0f766e)](CHANGELOG.md)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

## Connect

The production endpoint is `https://transitmcp.com/mcp`. No login is required. No client credentials, bearer token, or OAuth flow is required; Transit MCP does not collect client credentials. Stale `Authorization` headers are ignored.

The previous endpoint, `https://metro-mcp.anuragd.me/mcp`, will continue to be supported and serves the same Worker.

### Directories

- [OpenAI (ChatGPT/Codex)](https://chatgpt.com/plugins/plugin_asdk_app_6a9078f4d6dc8191be735cc1c2ff45b5)
- [Claude Directory](https://claude.ai/directory/metro-mcp)
- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.transitmcp%2Ftransit-mcp) (`com.transitmcp/transit-mcp`)
- [Smithery](https://smithery.ai/servers/transitmcp/transit-mcp)

### Claude

```bash
claude mcp add --transport http transit-mcp https://transitmcp.com/mcp
```

### Codex

```bash
codex mcp add transit-mcp https://transitmcp.com/mcp
```

### Generic Streamable HTTP client

```json
{
  "mcpServers": {
    "transit-mcp": {
      "type": "http",
      "url": "https://transitmcp.com/mcp"
    }
  }
}
```

`POST /mcp` is the recommended stateless Streamable HTTP endpoint. `POST` and `OPTIONS /sse` are a compatibility alias; legacy GET SSE, DELETE, session-message URLs, and slash variants return `405`.

## What it provides

This checkout registers 18 MCP tools: the 13 compatible DC/NYC tools plus five global capabilities, `find_transit`, `plan_trip`, `get_departures`, `get_service_status`, and `get_vehicle_status`. The compatible tools call WMATA and MTA directly for arrivals, service incidents, stations, routes, buses, trains, transfers, and vehicle positions.

All three regions serve the five global tools. Here's what they do:

- `plan_trip` plans trips between stations, or from map coordinates with short walks, using the published timetables and live predictions. In New York and DC it searches the rail network on its own. Anywhere, including the SF Bay Area and buses, you can name the lines to ride in `routes` (up to four) and it finds the real trips, stops, transfers and walks on them. When it can't search on its own it says why and returns `routeHints`: the lines near each end and the ones that serve both. Every itinerary is checked by an independent validator and comes with plain `steps` a rider can follow.
- `get_departures` with `toStop` answers "next train from A to B": only trips that go on to that stop, each with its arrival time there.
- `get_departures` merges the timetable with live trip updates. In NYC that includes rerouted trains and trains missing from the timetable, which are marked as observed rather than dropped. You can pass a station name directly; a station complex such as Times Sq-42 St or 14 St-Union Sq counts as one place and lists departures from every line in it, and genuinely different stations with the same name come back as choices.
- `get_service_status` returns the agencies' own alerts for a city, line, station, or trip, plus elevator and escalator outages there: whether each is on the step-free path, whether a backup elevator exists, and MTA's suggested way around.
- `plan_trip` with `accessibility: "step_free"` plans journeys that only board, alight and change where the platform is reachable without stairs, and avoids stations cut off by a current elevator outage. Station access comes from WMATA's GTFS and MTA's station list (including stations accessible in one direction only); if the live elevator report is missing or stale, it says so instead of guessing.
- `find_transit` resolves stations, stops, routes and train IDs. Stations rank ahead of street stops and rail ahead of bus, each candidate says what it is (station, platform or street stop, modes, lines), and a few reviewed place names work, such as SFO, Union Square, Penn Station, Grand Central and Dulles.
- `get_vehicle_status` shows where trains and buses are: on a line, on a dated trip from a departure board or planned journey, or at a station (every station of a complex). Each train reports its train ID (MTA's, such as `1A 1023 207/FAR`, or WMATA's number), the station it is stopped at or heading to, the station it last served, and its destination. DC trains carry GPS coordinates. MTA publishes stations rather than coordinates, so an NYC train stopped at a station is placed there and one between stations has no coordinates rather than a guessed one.

The NYC coverage also carries the Long Island Rail Road, Metro-North and NYC buses, and DC carries Metrobus. Journeys use every mode, buses included, and change between them on foot at stations such as Penn Station, Grand Central and Atlantic Terminal; LIRR and Metro-North departures show the track. The network planner searches compact timetables a cron builds in R2, then plans and validates the proposed lines exactly (see `src/transit/planner/network-plan.ts`). NYC bus predictions, locations and alerts come from MTA Bus Time; a self-hosted Worker without its key (`MTA_BUS_API_KEY`) serves NYC buses from the timetable only.

Timetables refresh automatically at the edge whenever WMATA, MTA or 511 SF Bay publish a new one. An update that would remove most of a day's service is rejected, and one that makes live matching worse is rolled back. See [DC and NYC global transit](docs/dc-nyc-global-transit.md) for how that works and what has been verified. SF Bay data comes from 511 SF Bay and participating operators, with their attribution on every result.

### Honest limits

- Late at night, when nothing runs within walking distance, `plan_trip` finds nothing and hands back `routeHints` instead.
- NYC trains between stations have no coordinates; MTA reports stations, not GPS.
- The first call after a quiet spell can take several seconds while the timetable loads.
- The 13 original tools are still here and unchanged for older clients.

It also provides four `transit://` URI templates (stations, routes, incidents, and versioned entities) and three canned prompts (`service-briefing`, `commute-planner`, and `accessibility-check`). Use `plan_trip` for journeys; do not assemble routes from departure boards. Global results distinguish `realtime`, `scheduled_only`, and `unavailable`, with source timestamps, versions, reasons, attribution, and a JSON text fallback.

An Apps-capable host can render the Transit Board resource for the 13 DC and NYC tools. See [the Apps verification record](docs/mcp-apps-verification.md).

## Runtime and safety boundaries

- **Protocol:** MCP `2026-07-28` stateless Streamable HTTP. The server does not advertise sessions, resumability, or server push.
- **Request trust:** public origin and host/origin allowlists are validated at startup. The signed MRTR request-state codec is bound to the MCP method and expires after five minutes.
- **Cancellation:** client disconnects propagate request cancellation to MCP handlers and upstream transit fetches.
- **Caching:** discovery and tool metadata are publicly cacheable for 24 hours. Station and route resources are public-cacheable; incident and versioned-entity resources are not. Legacy WMATA and MTA tools retain their provider caches. Global tools read versioned artifacts and snapshots without fetching upstream providers during a request.
- **Rate limiting:** roughly 300 requests per 60-second window per source-IP key per Cloudflare location. Shared egress IPs group clients, and enforcement is eventually consistent. This is abuse protection, not a dedicated user quota.
- **Rollback:** the inactive `MetroMcpAgent` class and original `v1` Durable Object migration remain for rollback. Do not add a deletion migration during stabilization.

## Deploy your own

Client access is anonymous. A self-hosted Worker still needs its own WMATA and 511 SF Bay API keys plus a stable `MCP_REQUEST_STATE_KEY` of at least 32 bytes for signed MRTR state.

```bash
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bun run dev
```

Use the checked-in loopback origin, hostname allowlists, and `ENVIRONMENT=development` values together. Keep `.dev.vars` out of source control. Production and preview use their own origins, allowlists, state keys, WMATA and 511 keys, artifact buckets, and `MCP_RATE_LIMITER` bindings.

Before an approved deployment, run only dry-runs:

```bash
production_out=$(mktemp -d /tmp/transit-mcp-production.XXXXXX)
preview_out=$(mktemp -d /tmp/transit-mcp-preview.XXXXXX)
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --env "" --outdir "$production_out"
node node_modules/wrangler/bin/wrangler.js deploy --env preview --dry-run --outdir "$preview_out"
```

## Verification

Run `bun run build && bun run test && bun run test:apps`. The conformance runner starts and stops its own isolated local Worker, uses the installed pinned referee, and gates a frozen product profile with mapped real tests. The full official score is reported separately and is not a product-profile pass:

```bash
./scripts/run-conformance.sh
```

See [global transit verification](docs/global-transit-verification.md) for current evidence and unpassed launch gates, [SF rollout](docs/sfbay-rollout.md) for activation prerequisites, and [security architecture](docs/SECURITY.md) for request boundaries. The [older MCP 2026 record](docs/mcp-2026-verification.md) is historical evidence, not this branch's acceptance.

## Support and legal

- [Documentation](https://transitmcp.com/docs/)
- [Privacy](https://transitmcp.com/privacy/)
- [Terms](https://transitmcp.com/terms/)
- [Support](https://transitmcp.com/support/)
- [Issues](https://github.com/Aarekaz/transit-mcp/issues)

## License

MIT. See [LICENSE](LICENSE).
