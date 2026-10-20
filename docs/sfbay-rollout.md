# SF Bay regional transit rollout

SF Bay support is in development. The checked-in production and preview configurations both use `SFBAY_MODE=dark`. No deployment or provider-data publication was performed for this verification package. The [verification record](global-transit-verification.md) distinguishes synthetic tests, local protocol checks, dry-run packaging, and missing live evidence.

## Stable tools, conditional data

Exactly five global tools are always registered alongside the 13 legacy tools: `find_transit`, `plan_trip`, `get_departures`, `get_service_status`, and `get_vehicle_status`. `/info` reports 18 tools and four transit resource templates. Modes change data availability, never the catalog. The existing Transit Board enhancement is limited to the legacy tools.

`off` disables ingestion and service; `dark` permits ingestion/validation but returns coverage unavailable; `on` permits serving validated data; `suspended` stops polling and permits only the documented stale-data behavior. `SFBAY_MODE` is authoritative for SF: `TRANSIT_COVERAGE_MODES` cannot override it. The centralized setting controls other coverage units; DC/NYC global planning defaults off and their legacy tools remain operationally independent.

## Prepare authoritative data

The [511 SF Bay provider documentation](https://511.org/open-data/transit), checked on 2026-10-18, documents the active consolidated regional schedule (`operator_id=RG`), regional realtime feeds (`agency=RG`), and a default shared token allowance of 60 requests per hour. An operator-authorized token is present only in the ignored local `.dev.vars`; never commit it, copy it into an artifact, or record a token-bearing URL. The live endpoints returned current decodable data, but the regional static archive failed the pinned canonical validator, so publication and activation remain blocked. Request no additional tokens, upload no objects, and change no remote secrets without the operator's authorization.

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

## Launch evidence (2026-10-19, production, SF dark)

**Data path.** The cron fetches 511's regional archive (`operator_id=RG`) with the production token, claiming the coordinator's static quota share first, and streams it to R2 (64,181,516 bytes, SHA-256 `f4150c68…e289`). SF builds stay offline: the cron never starts an edge build for them.

**Validation.** MobilityData GTFS Validator 8.0.1 on that archive: no system errors, 21 warning codes and 5 ERROR codes, all reviewed in `data/sfbay-validator-allowlist.json`. Each accepted ERROR concerns only inputs the build does not read (shapes and `shape_dist_traveled`, Fares v2 tables, and `trips.block_id`, which the SF build ignores and records in the source derivation); the gate checks this per build and per notice.

**Artifact.** `b4fdc773…` (published; pointer had no previous version): 19–26 Oct, 74,407 trips, 20,627 stops, 1-hour bands split into 12 agency groups (rail/ferry backbone together, the busiest agencies alone), 2,177 shards, largest 2.0 MB, manifest 1.08 MB.

**Realtime matching (>= 95% gate): passes.** Four consecutive production polls on version `14098d52`: 99.6% (1,835/1,842; 1,831/1,839; 1,809/1,817; 1,787/1,795). Muni, AC Transit, BART, VTA, SamTrans, Marin and the backbone match 100%; the misses are UC shuttles that 511's own calendar does not run today and two SFO AirTrain trips stuck at their 04:00 start. Excluded from the rate and logged per poll: ~160 trips predicted only beyond the 90-minute window and 15 stale entities whose every prediction predates the one-hour lookback. 511 deviates from GTFS-Realtime in ways handled only for this source (`providerQuirks` in `src/transit/gtfs/realtime/sources.ts`): no `start_date` on BART, Caltrain, Marin, SolTrans and others; `stop_sequence` one lower than the timetable for Muni and VTA; repeated and unordered calls; actual start times; and stale entities.

**Coordinator cost.** Before: 73–83 s wall and ~16–20 s CPU per alarm, with one alarm killed at the 30 s limit. After: trip updates 10.5–11.6 s CPU, 37–42 s wall; vehicle positions 0.1 s (resolved from the last trip-update matches); alerts 0.09 s.

**Freshness: not yet measured.** Trip updates poll every 120 s, the minimum 511's 60 requests an hour allow beside vehicles (300 s) and alerts; publishing completes ~38 s after a poll starts. Worst-case producer age is therefore near the 180 s threshold, and results there read `REALTIME_STALE`. A higher 511 allowance or a measured threshold decides this.

**Planning: does not pass.** On the published artifact, 6 of 30 sweep plans succeed (SamTrans/BART/Caltrain from SFO at every time, Caltrain at 22:00), all with valid legs; 24 exceed the planner's working-set budget. Hub stations (Embarcadero, 4th & King, Salesforce Transit Center) bring Muni and other large agencies into every search; one 2-hour Bay Area window needs more decoded timetable than a request isolate holds. Regional SF planning needs a dedicated planner with a compact resident timetable.

## Rollback

For an approved rollout, preserve the prior artifact pointer and Worker version. `suspended` halts polling; `off` disables service and ingestion. Confirm global tool results degrade/refuse appropriately and legacy DC/NYC tools still work. Keep all 18 tools registered. Do not delete Durable Object namespaces, the original rollback migration, or retained artifacts as part of rollback. Update public availability claims if SF is withdrawn.
