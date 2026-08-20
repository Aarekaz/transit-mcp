# Metro MCP Apps verification

Date: 2026-08-20 (America/New_York)

Release candidate: Metro MCP `5.0.0`

MCP Apps extension: stable `2026-01-26`

This record defines the reproducible local acceptance boundary for the Transit Board MCP App. It contains no access token, provider credential, identity, live transit response, or authorization artifact.

## Rendering and fallback boundary

All thirteen existing read-only tools reference `ui://metro-mcp/transit-board.html`:

| Tool | Dedicated view | Visual family |
| --- | --- | --- |
| `get_station_predictions` | Rail arrivals | Arrival |
| `search_stations` | Station search | Network |
| `get_stations_by_line` | Ordered line stations | Network |
| `get_all_stations` | Station directory | Network |
| `get_station_transfers` | Station transfers | Network |
| `get_incidents` | Service incidents | Service |
| `get_elevator_incidents` | Elevator and escalator incidents | Service |
| `get_bus_predictions` | Bus arrivals | Arrival |
| `get_bus_routes` | Bus route directory | Route |
| `get_bus_stops` | Bus stop directory | Route |
| `get_bus_positions` | Bus positions and normalized plot | Vehicle |
| `get_train_positions` | Train positions and circuit plot | Vehicle |
| `get_route_info` | Route detail | Route |

An Apps-capable host reads the shared UI resource, mounts it in a sandbox, then delivers tool input and result notifications. A client without Apps rendering support ignores the extension metadata and continues to receive the mandatory text fallback plus the unchanged structured result.

For this release, Codex fallback acceptance means authenticated discovery and ordinary DC/NYC tool calls. It is distinct from browser rendering: inline Apps rendering in Codex is not claimed. The local Chromium host below is the Apps rendering acceptance surface.

## Deterministic build and local host

Install the exact lockfile, rebuild the committed single-file resource, and run the local host acceptance:

```bash
bun install --frozen-lockfile
bun run build:apps
git diff --exit-code -- public/apps/transit-board.html
bunx playwright install chromium
bun run test:apps
```

`bun run test:apps` starts a new loopback-only Vite server at `127.0.0.1:4178`, opens `tests/apps/host.html`, and uses the Chromium revision managed by the exact `@playwright/test` `1.62.1` pin. The gating configuration never silently selects branded Chrome or reuses an existing server. The host loads `/apps/transit-board.html` in an iframe with exactly `sandbox="allow-scripts"`; it does not grant `allow-same-origin` or a permission-policy `allow` attribute.

The harness uses the official `AppBridge` and `PostMessageTransport` host APIs. It supplies initial host context through the `ui/initialize` response, waits for `ui/notifications/initialized`, then sends exactly one `ui/notifications/tool-input` before one `ui/notifications/tool-result`. Refresh `tools/call` requests are answered only from checked-in fixture objects. A source-filtered ledger classifies requests, notifications, success responses, error responses, and malformed messages, and correlates each response to one pending opposite-direction request in the same mount. There is no provider request, secret lookup, account access, or authorization emulation.

Security-effect instrumentation reports only to a Playwright-owned runner binding installed before navigation. It does not use `window.postMessage`, add a page `message` listener, or consume any Apps traffic, and its runner-owned record survives iframe remounts.

The visible host controls cover:

- all thirteen tool names;
- ready, empty, error, and hostile-text results;
- light and dark themes;
- inline and fullscreen display modes;
- zero or explicit safe-area insets;
- 736 and actual 320 CSS pixel iframe widths.

## Browser acceptance

The committed Playwright suite verifies:

- a dedicated semantic view for every tool name, with no raw-JSON renderer;
- screenshots for the arrival, service, network, route, and vehicle families under `output/playwright/`;
- exact input/result/context delivery and argument-preserving refresh after local UI filtering;
- native keyboard traversal, accessible control names, visible focus, and status announcements;
- an actual 320 CSS pixel iframe with no horizontal overflow;
- light/dark host context, inline/fullscreen transitions, and safe-area padding;
- native modern host values including `color-mix(in oklab, ...)`, OKLCH colors, and the host font stack;
- hostile transit markup rendered as literal text;
- in normal scenarios, exact empty sequences for console/page errors, unexpected external requests or WebSockets, network-constructor calls, storage or cookie access, privileged-browser API access, unexpected protocol methods, protocol violations, and requests still awaiting responses;
- adversarial probes for every recorded surface, including caught opaque-origin access before an iframe remount, hybrid marker/JSON-RPC traffic, unsolicited/duplicate/mismatched/missing responses, and malformed JSON-RPC. Acknowledgements accept only the exact new ordered observations; mixed expected-plus-unexpected probes demonstrate that unrelated effects remain failures.

Transient screenshots, traces, and failure artifacts are ignored under `output/playwright/` and are never committed.

## Public asset and security boundary

`public/apps/transit-board.html` is publicly readable and inert without a host lifecycle. It contains the view code and styles, never tool arguments, results, credentials, user identity, or server configuration. Authenticated MCP `resources/read` remains the protocol path that returns the same resource and its deny-by-default metadata.

The app allows no direct browser network, no browser storage, and no browser permissions. Its resource metadata declares empty `connectDomains`, `resourceDomains`, `frameDomains`, and `baseUriDomains`, requests no permissions, and sets `prefersBorder: false`. The only server interaction is host-mediated refresh of the originating allowlisted read tool.

## Release gates and external acceptance

The full local release gate is:

```bash
bun install --frozen-lockfile
bun run build
git diff --exit-code -- public/apps/transit-board.html
bun run test:unit
bun run test:workers
bun run test:apps
bun run test
bunx wrangler deploy --dry-run --outdir /tmp/metro-mcp-apps-prod-dry-run
bunx wrangler deploy --env preview --dry-run --outdir /tmp/metro-mcp-apps-preview-dry-run
git diff --check origin/main...HEAD
```

The full gate also includes named source and built-bundle policy scans for:

- secrets;
- `innerHTML` and equivalent executable HTML sinks;
- external URLs/assets;
- `fetch/XHR/WebSocket/EventSource`;
- storage/permission APIs;
- new Wrangler bindings;
- package-lock files;
- v1 server imports from the Apps package;
- OAuth/legacy-route changes.

Review every match rather than treating a text-search match as a finding. The compiled SDK contains inert protocol-schema descriptions of some APIs; the browser oracle separately proves that the app invokes none of them.

The Wrangler commands are dry-runs only. This feature does not deploy, change `wrangler.jsonc`, add a binding, modify an environment value, or change the server version.

Authenticated Codex fallback discovery plus one live DC and one live NYC call require an already authorized connector and are recorded separately when available. They do not replace the local Apps-capable browser acceptance and are not claimed here unless explicitly executed.
