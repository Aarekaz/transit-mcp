# DC and NYC on the global transit tools

DC (WMATA Metrorail) and NYC (MTA subway) serve the five global tools (`find_transit`, `plan_trip`, `get_departures`, `get_service_status`, `get_vehicle_status`) from versioned, validated schedule artifacts and coverage-owned realtime coordinators. The 13 legacy tools are unchanged and keep calling the agencies directly. Rollout is controlled only by `TRANSIT_COVERAGE_MODES`; the tool catalog never changes.

## Sources

| Coverage | Schedule (static) | Realtime | Vehicles |
| --- | --- | --- | --- |
| `dc` / feed `wmata` | `https://api.wmata.com/gtfs/rail-gtfs-static.zip` (key header) | Trip Updates, Vehicle Positions, Alerts from `api.wmata.com/gtfs/rail-gtfsrt-*.pb` (key header) | Yes: positions carry coordinates |
| `nyc` / feed `mta_subway` | MTA supplemented subway GTFS `https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip` (planned service changes for the coming days) | All eight NYCT trip-update documents (`gtfs`, `-ace`, `-bdfm`, `-g`, `-jz`, `-nqrw`, `-l`, `-si`) and `camsys/subway-alerts` | No: NYCT vehicle entities have a stop and status, not coordinates |

Provider rules live in `src/transit/gtfs/realtime/sources.ts` (server-side; public manifests never name credentials):

- **WMATA**: realtime `trip_id` equals the static `trip_id`. The key travels as the `api_key` header, never in a URL. Non-revenue moves (route `NR`, every stop `SKIPPED`) are excluded from the schedule-match rate because they serve no rider. Alert periods encoded with `end: 0` are open intervals.
- **NYCT** (`nyct_suffix`): realtime `trip_id` is the static `trip_id` after its first `_`; identity is (trip, service date, route) because `start_time` reports the actual dispatch. A matched train's reported stop list is its complete set of remaining calls: scheduled calls missing from it cannot be boarded (marked skipped), and reported stops outside the pattern are returned as `unscheduled_call`. Trains absent from the schedule are returned as `unmatched_trip`, never dropped. Alert agency `MTASBWY` is the static agency `MTA NYCT`; alerts naming a parent station apply to its platforms.
- **Every NYCT document is required.** A poll publishes only when all eight trip documents loaded, and a merge is dated by its oldest document. A missing or frozen document therefore leaves NYC realtime unavailable or stale (schedule-only results with `REALTIME_UNAVAILABLE`/`REALTIME_STALE`) instead of silently partial, because a train rerouted onto a line reports in its own line's document.

## Result contract additions

- `get_departures` rows carry `scheduleMatch`: `matched` (a call of a canonical scheduled trip instance), `unscheduled_call` (an observed stop outside that trip's pattern) or `unmatched_trip` (an observed train with no published schedule). Observed rows have `scheduledTime: null` and `stopSequence: null`; their headsign is the last reported stop.
- `plan_trip` and itinerary revalidation use only `matched` rows. Journeys are never built from predictions. Station (`location_type` 1) endpoints are satisfied at their own platforms; a name matching one station and its platforms resolves to the station, while different stations with one name (for example the four "Times Sq-42 St" complexes) stay `ENTITY_AMBIGUOUS`.
- `find_transit` reports effective capabilities: realtime kinds are true only when the coordinator is bound, any required credential is configured, and that feed kind is ingested. A train number resolves only from a fresh vehicle observation, to the dated trip it is running (DC); every train carrying the number is listed.

## Schedule artifacts

Artifacts are immutable and content-addressed. Each service date is split into three-hour first-departure bands (`timeRange` on every shard and descriptor), so a query decodes only the bands whose calls can overlap it. Partitioning refuses inputs a band boundary could cut (frequency templates, block continuations, trip-specific transfers) and drops GTFS-unusable trips (fewer than two timed stops).

### Rebuild and publish

WMATA republishes a rolling window of about nine days; the MTA supplemented feed changes as planned work is scheduled. Rebuild each coverage at least daily and before `feed_end_date`.

1. Download the archive; record its SHA-256 and UTC retrieval time. Never record a key-bearing request.
2. Validate those exact bytes with MobilityData GTFS Validator 8.0.1 (`java -jar gtfs-validator-8.0.1-cli.jar -i source.zip -o validation -c us`). Any ERROR, system error, unallowlisted WARNING or expired allowlist entry blocks publication. Allowlists: `data/<coverage>-validator-allowlist.json`.
3. If a publisher table must be excluded, build a derived archive without it (never edit rows), validate the derived archive, and pass `TRANSIT_DERIVED_FROM_SHA256`, `TRANSIT_DERIVED_EXCLUDED_FILES`, `TRANSIT_DERIVED_REASON` so the manifest records the derivation.
4. `bun scripts/build-transit-artifact.ts <out>` with `TRANSIT_COVERAGE`, `TRANSIT_FEED`, `TRANSIT_SOURCE_ARCHIVE`, `TRANSIT_GTFS_DIRECTORY`, `TRANSIT_SOURCE_URL`, `TRANSIT_SOURCE_RETRIEVED_AT`, `TRANSIT_VALIDATOR_REPORT`, `TRANSIT_VALIDATOR_SYSTEM_ERRORS`, `TRANSIT_WINDOW_START`, `TRANSIT_WINDOW_END`. The window may not exceed the publisher's feed dates.
5. `bun scripts/publish-transit-artifact.ts <out>/ <bucket> --remote` verifies every object, uploads objects, then the manifest, and moves `artifacts/<coverage>/v2/current.json` last (keeping `previous`). Use `--dry-run` first.

### Current DC exception

WMATA's `pathways.txt` (station accessibility graph) fails MobilityData 8.0.1 with ERROR `bidirectional_exit_gate` (one exit gate marked bidirectional) and `number_out_of_range` (four pathways with `traversal_time` 0). The DC artifact is built from a derived archive that excludes that optional table, validated with zero errors, and records the derivation. Consequences: DC transfers appear as `unverified` walks rather than pathway-verified ones, and no step-free routing is offered (it is not offered for any coverage). Revisit when WMATA corrects the table.

## Activation and rollback

1. Publish both artifacts to the target bucket.
2. Deploy with `TRANSIT_COVERAGE_MODES={"dc":"dark","nyc":"dark"}`: coordinators poll and log `regional_trip_match` (eligible/matched/rate/nonRevenue) while the tools still report the coverages unavailable.
3. Confirm healthy match rates and no `regional_feed_poll_failed` loop in `wrangler tail`, then deploy with `"on"`.
4. Run `bun scripts/probe-transit.ts <origin>`: `/info` and `tools/list` agree on 18 tools, each global tool answers for representative DC and NYC stations, and every legacy tool returns data.
5. Only after the probe passes may public copy describe DC/NYC global planning or live departures.

Rollback: set the coverage to `suspended` (stops polling) or `off` (no service), or move `current.json` back to `previous`. Never delete artifacts or Durable Object namespaces as part of rollback. Legacy tools are independent of these modes.

## Planner scaling on full networks

Real DC and NYC timetables exposed that the router kept every label it generated. It now applies standard RAPTOR pruning and honest accounting; every returned journey is still checked by the independent validator:

- **Per-stop Pareto bags**: a label is dropped when three retained labels at that stop are at least as early, with no more boardings and no more walking (three keeps distinct alternatives for the three returned itineraries). Pruning happens on numbers before any leg text is formatted.
- **Target pruning**: once three distinct journeys reach the destination, labels later than the third arrival are dropped.
- **Street walks end where riders can board**: boardable stops, or entrances into a published pathway graph; never generic nodes, boarding areas or station records. Walk neighbours are computed once per stop and charged to the budget.
- **Stations as endpoints**: a station (`location_type` 1) origin or destination is satisfied at any of its own platforms, in both the router and the independent validator.
- **Accounting**: shared leg objects are charged once at exact UTF-16 text size; signatures at their exact size; decoded shards keep the conservative 8x factor. A budget refusal returns `SCOPE_LIMIT_EXCEEDED`, never `COVERAGE_UNAVAILABLE`.

## Recorded evidence (2026-10-18/19, local)

| Check | Result |
| --- | --- |
| Official archives | NYC supplemented SHA-256 `8bd02532…6e408e` (retrieved 2026-10-19T00:46:25Z); WMATA SHA-256 `b9d427b0…10df719` (00:46:27Z); derived DC archive `4c521663…bd3d0` (pathways.txt excluded) |
| MobilityData GTFS Validator 8.0.1 (jar SHA-256 `19293ddd…1000e2`) | NYC: 0 errors, 0 system errors, 5 allowlisted warning codes. WMATA as published: 2 ERROR codes in pathways.txt. Derived DC: 0 errors, 0 system errors, 7 allowlisted warning codes |
| Artifacts (deterministic: rebuilt twice to identical versions) | DC `36b49029…7f063`: 48 three-hour shards (20261018–20261023), largest 0.93 MB. NYC `cbb48…85d39`: 126 shards (20261018–20261031), largest 2.55 MB |
| Decoded memory (real NYC) | 2 h rush window: 4.6 MiB raw, 17.5 MiB heap; 24 h: 17.3 MiB raw, 36 MiB heap |
| Live NYC ingestion (all eight trip documents + alerts) | 386–461 trip updates per poll; 61–75% match the supplemented schedule; the rest are kept as observed `unmatched_trip`; 54 reroutes observed in one sample |
| Live WMATA ingestion | 116–129 scheduled trips per poll, 100% matched; 10–12 non-revenue moves excluded; 16 vehicles on dated trips; 2 alerts (open `end: 0`) |
| Real plans with 800 m walking (Bun, single isolate) | DC: 0.15–0.44 s, estimate 13–22 MiB vs measured heap 11–21 MiB. NYC: 2.2–5.5 s, estimate 45–60 MiB vs measured 28–38 MiB. Every candidate validator-valid |
| Repository gates | `bun run build` (four TypeScript programs), 962 unit/integration tests, 33 Workerd tests, Apps bundle unchanged, frozen MCP product profile passed (raw official suite unchanged: 29 known diagnostic failures) |
| Local Worker (workerd, local R2, real coordinators) | 18 tools in `/info` and `tools/list`; NYC departures, plans, alerts live; DC schedules and plans served. Local workerd cannot reach `api.wmata.com` (legacy DC tools fail identically locally), so DC realtime was proven with the opt-in live acceptance test instead |

`tests/integration/dc-nyc-live.test.ts` repeats the live acceptance on demand: `TRANSIT_LIVE_COVERAGE=dc|nyc TRANSIT_LIVE_ARTIFACT_DIR=<built dir> WMATA_API_KEY=… bunx vitest run tests/integration/dc-nyc-live.test.ts`.

## Not yet established

- Production deployment, remote artifact publication and mode activation (require operator approval).
- Workers CPU for NYC plans: measured 2–5.5 s Bun wall time. Confirm deployed CPU time before relying on peak-hour planning.
- Agreement with official MTA/WMATA trip planners for current journeys.
- NYC vehicle locations (no coordinates in the feed) and NYCT train numbers (published in an MTA protobuf extension this decoder does not read).
- Step-free routing (not offered for any coverage).
