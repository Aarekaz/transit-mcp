# SF Bay regional transit rollout

SF Bay support is in development. The checked-in production and preview configurations both use `SFBAY_MODE=dark`. No deployment or provider-data publication was performed for this verification package. The [verification record](global-transit-verification.md) distinguishes synthetic tests, local protocol checks, dry-run packaging, and missing live evidence.

## Stable tools, conditional data

Exactly five global tools are always registered alongside the 13 legacy tools: `find_transit`, `plan_trip`, `get_departures`, `get_service_status`, and `get_vehicle_status`. `/info` reports 18 tools and four transit resource templates. Modes change data availability, never the catalog. The existing Transit Board enhancement is limited to the legacy tools.

`off` disables ingestion and service; `dark` permits ingestion/validation but returns coverage unavailable; `on` permits serving validated data; `suspended` stops polling and permits only the documented stale-data behavior. `TRANSIT_COVERAGE_MODES` can override by coverage, with `SFBAY_MODE` retained as SF's fallback. DC/NYC global planning defaults off; their legacy tools remain operationally independent.

## Prepare authoritative data

The [511 SF Bay provider documentation](https://511.org/open-data/transit), checked on 2026-10-18, documents the active consolidated regional schedule (`operator_id=RG`), regional realtime feeds (`agency=RG`), and a default shared token allowance of 60 requests per hour. The required token was not available in the verification environment. Request no additional tokens, upload no objects, and change no secrets without the operator's authorization.

1. With an authorized provider token, retrieve the current regional archive through HTTPS. Keep the token only at the request boundary; record the credential-free source URL, retrieval time, and archive/content hashes. Never save token-bearing URLs or raw provider error bodies.
2. Run a pinned canonical MobilityData validator on that same archive, retaining the validator version, report, system-errors report, and input hash. Errors, unknown warnings, or expired allowlist entries block publication. `data/sfbay-validator-allowlist.json` records accepted exceptions. An invented empty report is not validation evidence.
3. Extract the validated GTFS tables and build v2 objects locally. Provide `SFBAY_GTFS_DIRECTORY`, `SFBAY_VALIDATOR_REPORT`, `SFBAY_VALIDATOR_SYSTEM_ERRORS`, `SFBAY_WINDOW_START`, `SFBAY_WINDOW_END`, and `SFBAY_SOURCE_RETRIEVED_AT` through the environment, then run `bun scripts/build-sfbay-artifact.ts /absolute/temporary/artifact-output`. Dates use `YYYYMMDD`; include every acceptance service date.
4. Inspect the resulting `manifest.json`, source identity, discoveries, timetable shards, and content-addressed manifest. The runtime reads `artifacts/sfbay/v2/current.json`, whose `current`/`previous` fields name manifest hashes. Uploading a legacy gzip file does not publish a v2 artifact. The old `upload:sfbay-artifact*` package commands target the obsolete format and must not be used. An approved v2 uploader still needs to upload all immutable objects first, verify their integrity, and advance the pointer last using the semantics of `StaticArtifactStore.publish`.

The compiler consumes already downloaded/validated files; it does not itself fetch 511, execute the external validator, prove report authenticity, or upload to R2. Keep current and previous versions addressable, but only one resident in an isolate. Entity resources remain private/uncached until retention guarantees justify a public lifetime.

## Blocking activation checklist

- Current authoritative schedule and validator evidence; source-to-report identity verified by the operator pipeline.
- Live Trip Updates, Vehicle Positions, and Alerts compatible with that exact artifact. At least 95% of scheduled trip entities match after documented added/replacement exclusions.
- Producer-age behavior verified: Trip Updates through 180 seconds; Vehicle Positions through 360 seconds; Alerts through 20 minutes. Expiry, mismatch, missing/partial feeds, empty valid feeds, cancellation, and skipped stops degrade explicitly.
- Full launch corpus: data working set below 64 MiB and planner p95 CPU below 250 ms, including concurrent-request overhead. A small Bun fixture wall-time benchmark cannot pass these gates.
- Golden journeys for Muni, BART, Caltrain, and SamTrans, with zero invalid legs and positive recall. Compare current public test journeys with official planners at identical service dates/times and review every disagreement as described in the verification record.
- All repository/Apps checks, the reviewed frozen MCP product profile, production and preview dry-run packaging, and approved preview live smoke tests pass. Retain the full official suite's raw diagnostic failures separately; a product-profile pass must never be called full official conformance.
- 511 agreement/attribution acceptance, quota budget and cross-environment credential separation are recorded. If preview shares a production token, suspend preview polling.
- Explicit production deployment approval and a recorded rollback target.

Only after these gates pass may a proposed activation change set SF to `on`. Review the exact configuration and copy diff; deployment approval remains separate. Verify the deployed `/info`, all 18 tools, actual journey results and public pages before stating SF is live. Update README, landing-page description/Open Graph/Twitter/JSON-LD, docs, `llms.txt`, registry/social metadata, and release notes together. Do not describe DC/NYC global planning as live based on SF acceptance.

## Rollback

For an approved rollout, preserve the prior artifact pointer and Worker version. `suspended` halts polling; `off` disables service and ingestion. Confirm global tool results degrade/refuse appropriately and legacy DC/NYC tools still work. Keep all 18 tools registered. Do not delete Durable Object namespaces, the original rollback migration, or retained artifacts as part of rollback. Update public availability claims if SF is withdrawn.
