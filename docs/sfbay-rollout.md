# SF Bay regional transit rollout

SF Bay support is live with `SFBAY_MODE=on`, which registers the Bay Area MCP tools and keeps regional feeds current. `dark` ingests and validates data without registering tools, `off` disables ingestion, and `suspended` stops polling while retaining the last snapshots.

## Data path

The offline compiler converts the consolidated 511 Regional GTFS tables into deterministic, versioned artifacts. Realtime Trip Updates, Vehicle Positions, and Service Alerts are polled by one `RegionFeedHub` Durable Object on a fixed budget. MCP requests read cached snapshots only and never call 511 directly.

Build and upload the current static artifact before enabling the region:

```bash
SF511_API_KEY=... bun run build:sfbay-artifact
bun run upload:sfbay-artifact:preview
bun run upload:sfbay-artifact
```

The production and preview R2 buckets must exist before deployment. The gzip-compressed artifact is stored at `artifacts/sfbay/current.json.gz` in each bucket.

The default 511 limit is 60 requests per hour. The scheduler reserves capacity and applies a safety factor. API keys are appended only at the upstream request boundary and are redacted from URLs used outside that boundary.

## Activation and rollback gates

The live configuration depends on all of these remaining true:

- The 511 data agreement has been reviewed and attribution wording accepted.
- `SF511_API_KEY` is present as a Worker secret; never commit it or log it.
- A current Regional GTFS artifact has been compiled, validated, and uploaded.
- Dark-mode telemetry shows healthy producer timestamps, bounded payloads, and quota compliance.
- Preview smoke tests verify stale, expired, empty, malformed, and unavailable feed behavior.
- The production change and rollback (`SFBAY_MODE=suspended` or `off`) are explicitly approved.

## Current MCP surface

`search_sfbay_stations`, `get_sfbay_station_predictions`, `get_sfbay_routes`, `get_sfbay_incidents`, and `get_vehicle_positions` expose the live regional network with explicit freshness and 511 SF Bay attribution. Existing DC and NYC tool schemas remain unchanged.

Authoritative source: [511 SF Bay Transit Data](https://511.org/open-data/transit).
