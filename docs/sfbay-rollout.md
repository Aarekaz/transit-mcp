# SF Bay regional transit rollout

SF Bay support is intentionally dark by default. The worker may ingest and validate regional data while `SFBAY_MODE=dark`, but it does not register Bay Area MCP tools. `off` disables ingestion, `suspended` stops polling while retaining the last snapshots, and `on` registers the regional surface.

## Data path

The offline compiler converts the consolidated 511 Regional GTFS tables into deterministic, versioned artifacts. Realtime Trip Updates, Vehicle Positions, and Service Alerts are polled by one `RegionFeedHub` Durable Object on a fixed budget. MCP requests read cached snapshots only and never call 511 directly.

The default 511 limit is 60 requests per hour. The scheduler reserves capacity and applies a safety factor. API keys are appended only at the upstream request boundary and are redacted from URLs used outside that boundary.

## Activation gates

Do not set `SFBAY_MODE=on` until all of these are true:

- The 511 data agreement has been reviewed and attribution wording accepted.
- `SF511_API_KEY` is present as a Worker secret; never commit it or log it.
- A current Regional GTFS artifact has been compiled, validated, and uploaded.
- Dark-mode telemetry shows healthy producer timestamps, bounded payloads, and quota compliance.
- Preview smoke tests verify stale, expired, empty, malformed, and unavailable feed behavior.
- The production change and rollback (`SFBAY_MODE=suspended` or `off`) are explicitly approved.

## Current MCP surface

When enabled, `get_vehicle_positions` returns regional vehicles with explicit freshness, warnings, producer time, and 511 SF Bay attribution. Existing DC and NYC tool schemas remain unchanged.

Authoritative source: [511 SF Bay Transit Data](https://511.org/open-data/transit).
