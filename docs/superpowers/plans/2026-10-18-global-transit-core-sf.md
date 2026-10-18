# Global Transit Core and SF Bay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unshipped SF-specific surface with a compact global transit core, launch trustworthy SF Bay data and journey planning, and repair DC/NYC correctness without breaking their 13 public tool contracts.

**Architecture:** Five always-registered global MCP tools consume coverage-neutral schedule artifacts and realtime snapshots. SF is the first complete implementation: GTFS is compiled into bounded binary shards, realtime is polled independently of user traffic, a deterministic router produces candidates, and independent validation rejects inconsistent legs. DC and NYC retain their public tools while their incorrect direction, destination, freshness, and partial-feed behavior is repaired and then migrated behind the same global tools.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, R2, MCP TypeScript SDK v2, Zod 4, GTFS Schedule, GTFS-Realtime protobuf, Vitest, Cloudflare Workers Vitest pool, Playwright, Bun, Wrangler.

**Spec:** `docs/superpowers/specs/2026-10-17-sfbay-regional-transit-design.md`

## Global Constraints

- Keep the existing 13 tool names and strict required input/output keys compatible.
- Always register exactly five global capability tools: `find_transit`, `plan_trip`, `get_departures`, `get_service_status`, and `get_vehicle_status`.
- No MCP request may fetch an upstream transit provider.
- All global results carry status, fixed reason codes, source timestamps and versions, and required attribution.
- SF starts dark; do not claim it is live or deploy production in this plan.
- Initial SF thresholds: Trip Updates realtime through 180 seconds, Vehicle Positions through 360 seconds, Alerts through 20 minutes, static match rate at least 95 percent, and unverified walking at most 800 metres.
- Keep the artifact working set below 64 MiB and measured planner p95 CPU below 250 ms.
- Never log or persist API keys, request arguments, coordinates, place queries, stop references, itineraries, IP addresses, or personal aliases.
- Use Bun for repository scripts and tests; use Node-backed Wrangler commands for local and dry-run verification.
- Treat feed and agency text as untrusted input.

## Review Focus

- A bare number such as `91` must return network-qualified candidates and never silently select an operator; Task 2 tests it.
- A service after local midnight with a GTFS time above 24:00 must use the previous service day correctly; Task 4 tests it.
- A realtime snapshot matched to an older schedule version must degrade without loading two full artifacts; Task 5 tests it.
- A partial NYC feed failure must not look like a complete quiet station; Task 9 tests it.
- A client without elicitation support must receive a deterministic `ENTITY_AMBIGUOUS` candidate envelope; Task 7 tests it.

---

### Task 1: Reconcile the Unshipped Branch

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `README.md`
- Modify: `public/index.html`
- Modify: `public/docs/index.html`
- Modify: `public/llms.txt`
- Modify: `CHANGELOG.md`
- Modify: `docs/sfbay-rollout.md`
- Modify: `src/server-info.ts`
- Modify: `tests/unit/release-docs.test.ts`
- Modify: `tests/unit/server-info.test.ts`

**Interfaces:**
- Consumes: current `SFBAY_MODE` rollout values and existing documentation assertions.
- Produces: an unambiguously dark, non-live branch from which later tasks can safely build.

- [ ] **Step 1: Write failing release-state tests**

Add assertions that production and preview default to `dark`, public pages do not say SF is live, and `/info` cannot list unshipped SF-specific tools.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bunx vitest run --config vitest.config.ts tests/unit/release-docs.test.ts tests/unit/server-info.test.ts`

Expected: FAIL on current `on` configuration and live copy.

- [ ] **Step 3: Make the branch dark and remove premature claims**

Set both environments to dark, describe SF as in development, and keep attribution and rollout instructions without claiming production availability.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `fix: return SF rollout to dark mode`

### Task 2: Global Identity, Coverage Registry, and Result Envelope

**Files:**
- Create: `src/transit/core/refs.ts`
- Create: `src/transit/core/results.ts`
- Create: `src/transit/core/coverage.ts`
- Modify: `src/regions/types.ts`
- Modify: `src/regions/manifest.ts`
- Modify: `src/regions/sfbay.ts`
- Modify: `src/types.ts`
- Test: `tests/unit/transit-core.test.ts`
- Test: `tests/unit/regions.test.ts`

**Interfaces:**
- Produces: `TransitRef`, `TripInstanceRef`, `parseTransitRef(ref)`, `formatEntityRef(input)`, `formatTripInstanceRef(input)`, `CoverageManifest`, `CoverageCapability`, `TransitResultStatus`, `VerificationReason`, and `getCoverage(id)`.
- Consumes: existing SF feed definitions and attribution.

- [ ] **Step 1: Add failing reference and registry tests**

Test permanent `sfbay`, base64url provider IDs containing punctuation, dated trip-instance round trips, malformed references, coverage aliases, capability matrices, attribution, and the ambiguous query `91` returning candidates from distinct feeds.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `bunx vitest run --config vitest.config.ts tests/unit/transit-core.test.ts tests/unit/regions.test.ts`

- [ ] **Step 3: Implement the core types and registry**

Use `tr:{coverage}:{feed}:{kind}:{encoded-id}` and append service date plus encoded start time for trip instances. Replace hard-coded secret and mode property types with registry references while retaining secret values exclusively in Worker bindings.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: add global transit identity and coverage registry`

### Task 3: Coverage-Neutral Static Artifact Format

**Files:**
- Create: `src/transit/gtfs/static/schema.ts`
- Create: `src/transit/gtfs/static/shards.ts`
- Modify: `src/transit/gtfs/static/artifact.ts`
- Modify: `src/transit/gtfs/static/compiler.ts`
- Modify: `src/transit/gtfs/static/time.ts`
- Modify: `scripts/build-sfbay-artifact.ts`
- Test: `tests/unit/gtfs-static.test.ts`
- Test: `tests/fixtures/sfbay-gtfs/transfers.txt`
- Test: `tests/fixtures/sfbay-gtfs/feed_info.txt`

**Interfaces:**
- Consumes: `CoverageManifest` and raw GTFS tables.
- Produces: `ArtifactManifestV2`, `ScheduleShard`, `compileSchedule(input)`, `encodeScheduleShard(shard)`, `decodeScheduleShard(bytes)`, and content-addressed R2 keys.

- [ ] **Step 1: Add failing compiler tests**

Cover ordered patterns, `agency_timezone`, `feed_info`, `calendar_dates`, frequencies, blocks, transfers, pathways, stable output hashes, source metadata, and service times beyond 24:00.

- [ ] **Step 2: Verify the current compiler fails the new contract**

Run: `bunx vitest run --config vitest.config.ts tests/unit/gtfs-static.test.ts`

- [ ] **Step 3: Implement deterministic binary shards**

Shard by feed and service-day window. Keep the stop and route discovery index separate from timetable shards. Reject missing references and nonmonotonic trip times before publication.

- [ ] **Step 4: Add the MobilityData validator gate**

Make the build script fail on errors and on warnings not present in a checked-in SF allowlist containing a reason and expiry date.

- [ ] **Step 5: Run focused tests and build a fixture artifact**

Expected: PASS and byte-identical artifacts across two builds.

- [ ] **Step 6: Commit**

Commit: `feat: compile versioned global GTFS shards`

### Task 4: Service-Day and Schedule Query Engine

**Files:**
- Create: `src/transit/planner/service-day.ts`
- Create: `src/transit/planner/schedule-index.ts`
- Create: `src/transit/planner/departures.ts`
- Test: `tests/unit/service-day.test.ts`
- Test: `tests/unit/departures.test.ts`

**Interfaces:**
- Consumes: `ArtifactManifestV2`, `ScheduleShard`, stop and route references.
- Produces: `serviceDaysForInstant(instant, agencyTimezone)`, `loadScheduleWindow(query)`, and `getScheduledDepartures(query)`.

- [ ] **Step 1: Add failing time tests**

Cover spring-forward and fall-back days, local midnight, previous-day trips above 24:00, holiday exceptions, an uncovered service date, bounded future windows, and first/last departure queries.

- [ ] **Step 2: Run tests and verify failure**

Run: `bunx vitest run --config vitest.config.ts tests/unit/service-day.test.ts tests/unit/departures.test.ts`

- [ ] **Step 3: Implement service-day resolution and scheduled departures**

Use GTFS's noon-minus-12-hours rule and agency timezones. Do not use artifact generation age as schedule validity.

- [ ] **Step 4: Run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: add schedule and service-day queries`

### Task 5: Version-Pinned Realtime Snapshots

**Files:**
- Create: `src/transit/gtfs/realtime/trip-match.ts`
- Create: `src/transit/gtfs/realtime/snapshot-store.ts`
- Modify: `src/transit/gtfs/realtime/decode.ts`
- Modify: `src/transit/gtfs/realtime/freshness.ts`
- Modify: `src/transit/gtfs/realtime/hub-core.ts`
- Modify: `src/transit/gtfs/realtime/region-feed-hub.ts`
- Modify: `src/transit/gtfs/realtime/service.ts`
- Test: `tests/unit/gtfs-realtime.test.ts`
- Test: `tests/unit/regional-service.test.ts`

**Interfaces:**
- Consumes: `ArtifactManifestV2`, realtime protobufs, manifest thresholds, R2, and Durable Object storage.
- Produces: `NormalizedRealtimeSnapshot`, `matchTripInstance()`, `applyTripUpdates()`, and `RealtimeSnapshotStore` with indexed R2 shards.

- [ ] **Step 1: Add failing normalization and storage tests**

Cover `trip_id` plus `start_date`, frequency `start_time`, `stop_sequence`, delay propagation, every supported schedule relationship, `NO_DATA`, version mismatch, 2 MB metadata bounds, and API-key-wide quota accounting.

- [ ] **Step 2: Verify current behavior fails**

Run: `bunx vitest run --config vitest.config.ts tests/unit/gtfs-realtime.test.ts tests/unit/regional-service.test.ts`

- [ ] **Step 3: Implement complete normalization and version pinning**

Store payload shards in R2 and only metadata/indexes in the Durable Object. Exclude added and replacement service from the static-match denominator. Sanitize and cap agency text.

- [ ] **Step 4: Implement manifest freshness behavior**

Apply the SF thresholds exactly. Return scheduled-only for stale Trip Updates, unavailable for expired Vehicle Positions, and preserve explicit observation ages.

- [ ] **Step 5: Run focused tests**

Expected: PASS.

- [ ] **Step 6: Commit**

Commit: `feat: publish version-pinned realtime snapshots`

### Task 6: Deterministic Router and Independent Validator

**Files:**
- Create: `src/transit/planner/types.ts`
- Create: `src/transit/planner/raptor.ts`
- Create: `src/transit/planner/validator.ts`
- Create: `src/transit/planner/plan.ts`
- Test: `tests/unit/planner.test.ts`
- Test: `tests/unit/itinerary-validator.test.ts`

**Interfaces:**
- Consumes: schedule shards, normalized realtime snapshots, endpoint coordinates or stop refs, departure time, and maximum walking distance.
- Produces: `planJourney(query, signal)`, `validateItinerary(itinerary, source, signal)`, `Itinerary`, `ItineraryLeg`, and `ValidationResult`.

- [ ] **Step 1: Add failing route and mutation tests**

Cover direct trips, transfers, minimum transfer times, same-vehicle blocks, wrong direction, reversed stops, inactive service, cancellation, skipped stop, and a validator that rejects every deliberately corrupted itinerary.

- [ ] **Step 2: Run tests and verify failure**

Run: `bunx vitest run --config vitest.config.ts tests/unit/planner.test.ts tests/unit/itinerary-validator.test.ts`

- [ ] **Step 3: Implement the minimal depart-at router**

Use the required shards only, check `AbortSignal` between rounds, cap unverified walks at 800 metres, and return at most three candidates.

- [ ] **Step 4: Implement the independent validator**

Use separate validation code over canonical trip stop-times. Discard invalid candidates; never repair them.

- [ ] **Step 5: Run focused tests and benchmark fixture corpus**

Expected: PASS, working set below 64 MiB, and p95 below 250 ms. If not, stop and move the same interface behind a dedicated Durable Object rather than weakening limits.

- [ ] **Step 6: Commit**

Commit: `feat: add deterministic transit journey planning`

### Task 7: Five Global MCP Tools

**Files:**
- Create: `src/mcp/tools/global/shared.ts`
- Create: `src/mcp/tools/global/find.ts`
- Create: `src/mcp/tools/global/plan.ts`
- Create: `src/mcp/tools/global/departures.ts`
- Create: `src/mcp/tools/global/service-status.ts`
- Create: `src/mcp/tools/global/vehicle-status.ts`
- Create: `src/mcp/tools/global/index.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/context.ts`
- Modify: `src/mcp/prompts.ts`
- Modify: `src/mcp/resources.ts`
- Modify: `apps/transit-board/src/app.ts`
- Modify: `apps/transit-board/src/model.ts`
- Modify: `apps/transit-board/src/render.ts`
- Delete: `src/mcp/tools/regional.ts`
- Test: `tests/unit/mcp-global-tools.test.ts`
- Modify: `tests/fixtures/mcp-contracts.ts`
- Modify: `tests/apps/fixtures.ts`
- Modify: `tests/apps/transit-board.spec.ts`
- Modify: `tests/unit/mcp-app-renderer-contracts.test.ts`

**Interfaces:**
- Consumes: registry, planner, schedule queries, realtime snapshots, existing request-state codec.
- Produces: five always-registered MCP tools, `transit://entity/{ref}?version=...`, and `TransitRequestState` union variants.

- [ ] **Step 1: Add failing catalog and behavior tests**

Lock names, titles, selection-oriented descriptions, annotations, strict schemas, text/structured parity, runtime coverage availability, `find_transit({ref})` detail, one-call named endpoints, default-now behavior, and the stable error envelope.

- [ ] **Step 2: Add ambiguity and client-capability tests**

Cover contextual ranking without silent selection, origin and destination elicited together, no-elicitation `ENTITY_AMBIGUOUS`, mismatched signed state, unknown references, and absence of raw agency text in errors.

- [ ] **Step 3: Run tests and verify failure**

Run: `bunx vitest run --config vitest.config.ts tests/unit/mcp-global-tools.test.ts tests/unit/mcp-catalog.test.ts`

- [ ] **Step 4: Register the global tools unconditionally**

Remove SF-mode-dependent registration. Keep mode checks inside services. Rewrite server instructions and `commute-planner` so journey questions always select `plan_trip`.

- [ ] **Step 5: Remove stale regional app mappings**

Delete SF-specific tool-to-renderer metadata. Do not attach `TRANSIT_BOARD_TOOL_META` or advertise an MCP App for a global tool until that renderer supports the tool's structured result and has contract plus browser coverage. Keep the existing app intact for still-supported legacy tools.

- [ ] **Step 6: Add the single entity resource**

Expose application-controlled static detail while keeping the same essential detail available through `find_transit({ref})`.

- [ ] **Step 7: Run focused, app-contract, and worker tests**

Run: `bunx vitest run --config vitest.config.ts tests/unit/mcp-global-tools.test.ts tests/unit/mcp-catalog.test.ts tests/unit/mcp-app-renderer-contracts.test.ts && bun run test:apps && bun run test:workers`

Expected: PASS.

- [ ] **Step 8: Commit**

Commit: `feat: expose compact global transit tools`

### Task 8: SF Coverage, Aliases, and Golden Journeys

**Files:**
- Create: `data/coverage/sfbay/aliases.json`
- Create: `tests/fixtures/sfbay-golden-journeys.json`
- Create: `tests/integration/sfbay-journeys.test.ts`
- Modify: `src/regions/sfbay.ts`
- Modify: `tests/unit/regions.test.ts`
- Modify: `tests/workers/mcp-worker.test.ts`

**Interfaces:**
- Consumes: global tools, planner, SF artifacts and snapshots.
- Produces: reviewed SF aliases and launch evidence for Muni, BART, Caltrain, and SamTrans.

- [ ] **Step 1: Add failing SF corpus tests**

Include Pier 39 to SFO, BART to Caltrain at Millbrae, Muni-only, Caltrain-only, SamTrans airport, stale realtime, alert, cancellation, no-service, and ambiguous-place cases.

- [ ] **Step 2: Add source-backed alias data**

Map SF, San Francisco, Bay Area, Pier 39, and SFO to coverage or place entries with provenance. Do not add personal aliases.

- [ ] **Step 3: Run the SF corpus**

Run: `bunx vitest run --config vitest.config.ts tests/integration/sfbay-journeys.test.ts tests/workers/mcp-worker.test.ts`

Expected: PASS with no invalid itinerary returned.

- [ ] **Step 4: Commit**

Commit: `test: prove SF journey and query coverage`

### Task 9: DC and NYC Honesty Repairs

**Files:**
- Modify: `src/transit/wmata-client.ts`
- Modify: `src/transit/mta-client.ts`
- Modify: `src/mcp/prediction-format.ts`
- Modify: `src/mcp/tools/stations.ts`
- Test: `tests/unit/legacy-transit-correctness.test.ts`
- Modify: `tests/unit/station-prediction-format.test.ts`
- Modify: `tests/unit/mcp-stations.test.ts`

**Interfaces:**
- Consumes: current WMATA and MTA public contracts.
- Produces: correct direction, destination, arrival classification, timestamps, and completeness without schema changes.

- [ ] **Step 1: Add failing DC and NYC regression fixtures**

Pin WMATA track/direction, Metro Center relationships, Dupont-to-Metro-Center direction, NYC headsigns, dropping departed trains, realtime status classification, missing timestamps, and partial-feed failure behavior.

- [ ] **Step 2: Run tests and verify current failures**

Run: `bunx vitest run --config vitest.config.ts tests/unit/legacy-transit-correctness.test.ts tests/unit/station-prediction-format.test.ts tests/unit/mcp-stations.test.ts`

- [ ] **Step 3: Correct normalization without changing schemas**

Use fixed safe errors for incomplete relevant feeds. Never replace unknown timestamps with the current clock.

- [ ] **Step 4: Run all unit and worker tests**

Run: `bun run test:unit && bun run test:workers`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `fix: make DC and NYC transit results honest`

### Task 10: DC and NYC Global-Tool Migration

**Files:**
- Create: `src/regions/dc.ts`
- Create: `src/regions/nyc.ts`
- Create: `tests/fixtures/dc-golden-journeys.json`
- Create: `tests/fixtures/nyc-golden-journeys.json`
- Create: `tests/integration/dc-nyc-journeys.test.ts`
- Modify: `src/regions/manifest.ts`
- Modify: `src/transit/registry.ts`

**Interfaces:**
- Consumes: global core and repaired legacy adapters.
- Produces: `dc` and `nyc` coverage entries behind the five global tools while preserving legacy tools.

- [ ] **Step 1: Add failing coverage and journey tests**

Include Dupont Circle to DCA, the wrong-way Red Line mutation, NYC local versus express, transfers, weekend service, and live-feed degradation.

- [ ] **Step 2: Add DC and NYC manifests and adapters**

Reuse shared router interfaces. Keep native WMATA bus, elevator, and train-position functionality as overlays.

- [ ] **Step 3: Run the three-city global-tool corpus**

Run: `bunx vitest run --config vitest.config.ts tests/integration/sfbay-journeys.test.ts tests/integration/dc-nyc-journeys.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

Commit: `feat: serve DC and NYC through global transit tools`

### Task 11: Privacy-Safe Usage Analytics and Evaluation Harness

**Files:**
- Modify: `src/metrics.ts`
- Modify: `src/telemetry.ts`
- Create: `scripts/query-anonymous-usage.ts`
- Create: `scripts/run-prompt-evals.ts`
- Create: `tests/evals/transit-prompts.json`
- Modify: `tests/unit/metrics.test.ts`
- Modify: `tests/unit/telemetry.test.ts`
- Create: `tests/unit/prompt-evals.test.ts`

**Interfaces:**
- Consumes: Analytics Engine rows and the public MCP endpoint.
- Produces: anonymized daily tool-call counts, tool/client/status breakdowns, synthetic prompt-evaluation reports, and no user-level analytics.

- [ ] **Step 1: Add failing privacy and classification tests**

Prove only `tools/call` and legacy `initialize` events are counted, no arguments or location fields can serialize, production and preview are separable, and synthetic/test clients can be excluded only by explicit client/environment filters.

- [ ] **Step 2: Implement the read-only usage query script**

Report total tool calls, successful calls, tool distribution, known client distribution, and an explicit `unclassified` bucket. Do not label a call “human” or “real” without evidence the schema actually records.

- [ ] **Step 3: Add prompt evaluations**

Cover natural home/work context passed as resolved inputs, ambiguity, all three cities, stale data, impossible routes, injection-like alerts, proactive future-window checks, and tool-selection accuracy.

- [ ] **Step 4: Run focused tests**

Run: `bunx vitest run --config vitest.config.ts tests/unit/metrics.test.ts tests/unit/telemetry.test.ts tests/unit/prompt-evals.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: add anonymous usage and prompt evaluation tooling`

### Task 12: Full Verification and Preview Rollout Package

**Files:**
- Modify: `.github/workflows/type-check.yml`
- Modify: `scripts/run-conformance.sh`
- Create: `docs/global-transit-verification.md`
- Modify: `docs/sfbay-rollout.md`
- Modify: `README.md`
- Modify: `public/docs/index.html`
- Modify: `public/privacy/index.html`
- Modify: `public/terms/index.html`

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: repeatable CI gates, dry-run artifacts, preview checklist, and an honest launch decision package.

- [ ] **Step 1: Add the frozen MCP conformance requirement set to CI**

Run the local Worker against `2026-07-28`; score required scenarios and report optional extensions separately.

- [ ] **Step 2: Run repository verification**

Run: `bun run build && bun run test && bun run test:apps`

Expected: all pass.

- [ ] **Step 3: Run deployment dry-runs**

Run production and preview Wrangler dry-runs without deploying. Verify bindings, artifact sizes, startup, and absence of secret values from output.

- [ ] **Step 4: Run three-city prompt stress tests**

Require zero invalid legs, correct ambiguity behavior, explicit degradation, and accurate tool selection. Record disagreements with official planners for review rather than silently accepting either side.

- [ ] **Step 5: Update verification and rollout documentation**

Keep SF described as dark or preview until a separately approved production deployment passes live-feed and golden-route checks. Preserve the public anonymous/no-auth/privacy description.

- [ ] **Step 6: Commit**

Commit: `docs: package global transit verification and rollout`
