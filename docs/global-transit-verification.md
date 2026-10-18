# Global transit verification and launch decision

Recorded 2026-10-18 for the global transit branch. SF remains **dark** in both checked-in environments. DC/NYC global planning defaults off. This package makes no production deployment, live SF availability, or official-planner agreement claim. Thirteen legacy contracts plus exactly five global tools remain the public schema boundary.

## Evidence classes

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Unit, Workerd, golden corpora and prompt fixtures | Deterministic contracts, validated synthetic routing, ambiguity and degradation | Current provider data or real-world route agreement |
| Local pinned conformance | Actual Worker HTTP behavior under frozen MCP requirements | A deployed endpoint, live transit data, or an automatic waiver of diagnostic-fixture failures |
| Wrangler production/preview dry-runs | Bundle generation and declared bindings | Deployment, configured remote secrets, R2 contents, or measured deployed startup/CPU |
| Full authoritative artifact and live snapshots | Not established in this run | Synthetic fixtures cannot substitute for these |
| Production state | No production mutation performed | Branch/config changes do not prove deployment state |

## Reproduce repository and protocol checks

```sh
bun install --frozen-lockfile
bun run build && bun run test && bun run test:apps
bunx vitest run --config vitest.config.ts tests/integration/sfbay-journeys.test.ts tests/integration/dc-nyc-journeys.test.ts tests/unit/prompt-evals.test.ts tests/unit/itinerary-validator.test.ts
bun scripts/run-prompt-evals.ts --dry-run
bun tests/planner-benchmark.ts
bash scripts/run-conformance.sh
```

`build` includes all four TypeScript programs. The committed Apps bundle must remain reproducible (`git diff --exit-code -- public/apps/transit-board.html`). The small planner benchmark includes decode, routing, and independent validation; its p95 is **Bun wall time**, not full-corpus Workers CPU, and its heap delta is not a measured concurrent launch working set.

The conformance shell wrapper invokes Node and never downloads a latest suite. The installed dependency is exactly `@modelcontextprotocol/conformance@0.2.0-alpha.11`, with its lockfile integrity and frozen `requirements/2026-07-28.yaml` (SHA-256 `ae2f4f6210fd729e2e318edd5bbfa31a43cee0bc608e48052fa26dbf1d939b57`). The runner rejects another version or requirement hash. It starts a fresh local Worker from the real `src/index.ts`, waits for `/info`, then runs all 37 required server scenarios plus 10 optional Task extensions and three pending scenarios. It does not add diagnostic tools to the product catalog.

Each run creates a private `transit-mcp-conformance-*` temporary directory. Its isolated config has local R2/DO/rate-limit bindings, all global coverage off, no cron, remote routes, or analytics, and public dummy signing/WMATA values only. Provider/Cloudflare credentials and checkout `.dev.vars` are not inherited. The runner owns and terminates only its child process groups; it never kills another process or deletes user files. It retains the requirement list, raw local check files/log, redacted-to-status `summary.json`, and `run.json`. Missing or malformed required results fail closed. Interruptions and timeouts fail. Local artifacts can contain synthetic public conformance inputs; CI publishes only summary/log files, not runtime state.

CI blocks on the frozen **product profile**, not a claim of full official conformance. The raw official exit code and all 29 required diagnostic failures remain unchanged in `summary.json` and `run.json`; optional extension and pending counts are separate. The checked-in [application profile](../scripts/mcp-conformance-profile.json), revision `transit-mcp-2026-07-28-v1`, enumerates each known diagnostic check by scenario, exact check ID, exact failure message, rationale, and named real test evidence. Any other failure, changed diagnostic message, missing required scenario, failed/missing/renamed mapped test, startup failure or interruption blocks the product profile. The runner executes the mapped SDK and assembled-Workerd suites afresh and verifies the named tests passed in their JSON reports. It never converts a raw official failure to success, and there is no blanket expected-failure file or `continue-on-error`.

| Raw required failure category | Checks | Product evidence / applicability |
| --- | ---: | --- |
| Stateless diagnostic tools absent | 4 | Real capability fallback, no unsolicited requests/logging, and assembled Worker calls. |
| Diagnostic `test_*` tools absent | 7 | Actual 18-tool schemas, text/structured parity, operational errors and progress; product emits no image/audio/mixed tool bodies. |
| Diagnostic `test://` resources absent | 3 | Actual transit JSON resources, versioned entity reads, and errors; no binary product resource path. |
| Diagnostic prompts absent | 4 | Every real prompt/argument variant; product prompts contain text only. |
| Diagnostic MRTR fixtures absent | 10 | Actual station/journey elicitation, signed-state tamper rejection, capability fallback and one-round completion. Sampling, roots, multi-round and prompt elicitation are not product paths. |
| Completion capability absent | 1 | Exact advertised capability set and method-not-found for unadvertised completion. |

This is a product-specific protocol acceptance profile. It is **not full official conformance**, and it cannot establish unimplemented callback/content paths or live transit correctness. The exact per-check mapping remains reviewable in the JSON profile; all applicable official checks still have to pass.

## Recorded execution

Executed on 2026-10-18 with Bun 1.3.14 and Node 26.7.0. The detailed local operator report is `.superpowers/sdd/2026-10-18-global-transit-core-sf/task-12-report.md` (not committed because the SDD directory is intentionally ignored).

| Check | Recorded result |
| --- | --- |
| `bun run build && bun run test && bun run test:apps` | Exit 0: all four TypeScript programs, 899 unit/integration tests, 33 Workerd tests, 62 browser tests. Generated Apps bundle unchanged. |
| Focused SF/DC/NYC routing, prompt and validator stress | 96 tests passed; all returned journey candidates independently validated. |
| Scripted prompt replay | 11/11 scenarios passed, zero failed; tool-selection agreement 1.0 against fixture traces, **not an LLM evaluation**. |
| Frozen product conformance profile | Exit 0; 29 exact diagnostic classifications, no unknown failures, no missing evidence, no incomplete required checks. Mapped suites: 151 SDK/unit and 33 assembled-Worker tests passed. |
| Full official required score | **Exit 1, not a pass:** 37 required scenarios, 78 successful checks, 29 failed checks across 26 scenarios, four warnings, zero skipped/missing. |
| Optional Tasks extensions | Separately reported: 10 scenarios, 12 successful checks, 30 failed, one skipped. Not required-score deductions. |
| Pending scenarios | Separately reported: three scenarios, 16 successful checks, six failed. Not required-score deductions. |
| Production and preview dry-runs | Both exit 0; each bundle 1973.76 KiB, gzip 490.62 KiB; `index.js` 2,021,130 bytes. Expected binding names present, `SFBAY_MODE=dark` in both. No deployment or startup CPU measurement. |
| Small fixture planner benchmark | 100 samples: p50 5.220 ms, p95 22.714 ms, max 24.585 ms; estimated data working set 1,424,112 bytes; peak heap 9,006,356 bytes and external memory 3,306,888 bytes. These are synthetic local measurements, **not the full-corpus launch gates**. |

Initial local port binding was blocked by sandbox `EPERM`; rerunning with permission for local networking passed. During development, tests exposed an invalid isolated Worker environment/missing mandatory dummy WMATA setting and stale legal-date/CI command assertions; these were corrected and the entire command above rerun green. Self-review added a RED/GREEN regression ensuring skipped or unknown required checks cannot pass the profile. Nonfatal third-party source-map and color-environment warnings remain; no test failures were suppressed.

## Live activation gates

| Gate | Current evidence / decision |
| --- | --- |
| Current 511 regional static artifact | Unpassed: no configured local `SF511_API_KEY`; local artifacts are synthetic fixtures only. |
| Canonical validator on that artifact | Unpassed: compiler/report gate tests exist, but no current authoritative archive/report pair was validated here. |
| Live realtime compatibility and >=95% scheduled-trip matching | Unpassed: no authorized local 511 credential or matching authoritative artifact. |
| Freshness, version mismatch, incomplete feeds, cancellation | Synthetic suites exercise these; live producer-age and quota evidence remains unpassed. |
| Full artifact data working set <64 MiB | Unpassed: tiny fixture benchmark only, no full launch corpus/concurrent-request measurement. |
| Planner p95 CPU <250 ms | Unpassed: Bun wall time does not establish Workers CPU; full launch measurement required. |
| Current golden-route agreement | Unpassed: SF/DC/NYC corpora are explicitly synthetic; official planner pages were inspected, but no current itinerary pair was compared. |
| Frozen required protocol product profile | See recorded product result and unchanged full official failures separately; never label the product profile full official conformance. |
| Preview live smoke, attribution acceptance and quota separation | Unpassed; no deployment, secret provisioning, agreement acceptance, or shared-token change performed. |
| Production activation/deployment | Not authorized or performed. Keep dark. |

Current [511 documentation](https://511.org/open-data/transit) confirms token requirements for the regional schedule and realtime feeds and the default 60 requests/hour per token. Only token presence was inspected locally; no token values were printed or saved. No Cloudflare analytics or production state was queried.

## Three-city prompt stress and disagreement review

The prompt replay tests 11 fixed scenarios covering resolved client context, ambiguous endpoints, SF/DC/NYC journeys, stale departures, impossible routes, agency-text injection, future windows, observed vehicles, and coverage discovery. `toolSelectionAccuracy` is agreement of a scripted trace with the expected tool. Its 100% score is not LLM accuracy: no model chooses a tool or generates an answer. The real SDK golden corpora and independent validator tests provide the separate routing evidence; illustrative prompt results alone are not routing tests.

Acceptance requires zero invalid returned legs across every returned candidate, positive expected journey recall, no silent endpoint selection, an explicit unavailable result with no itineraries for impossible/canceled service, correct scheduled-only reasons for stale/missing realtime, and inert labelled provider text. Mutation cases prove wrong-way Red Line, reversed stops, bad transfers, skipped/canceled service, expired schedules and version mismatches are rejected. Caller ambiguity must retain candidates for clients without elicitation. Public user travel data must never be copied into a report.

Use only public synthetic test endpoints for external comparison. For the current authoritative corpus, compare Pier 39–SFO, Embarcadero/Millbrae BART–Caltrain, a Muni-only trip, a Caltrain-only trip, and a SamTrans airport trip. Compare DC Dupont–DCA and representative NYC local/express/transfer journeys separately before claiming their global planning is live. Inspect the [SFMTA planner](https://www.sfmta.com/trip-planner), [BART planner](https://www.bart.gov/planner), [Caltrain schedules](https://www.caltrain.com/schedules), and the official SamTrans site. These source pages were checked on 2026-10-18; opening a planner is not evidence of a matching itinerary. The attempted SamTrans `/plan-your-trip` page did not return usable content.

For each comparison, record a case ID, public endpoints, exact departure instant/timezone/service date, retrieval time, static hash, realtime producer/ingestion timestamps, modes, walking limit, transfers and arrival. Save a credential-free official URL or approved public evidence. On disagreement, classify the difference (input resolution, service date, topology/direction, cancellation, transfer/walk allowance, or stale snapshot), re-run the independent validator, and inspect canonical agency facts. Neither comparator wins by default. Keep the case blocked until a reviewed fix or documented evidence resolves it; never rewrite a fixture to imitate a preferred answer. No current official-planner agreement was established in this task.

## Packaging and copy boundary

For packaging only, use Node-backed Wrangler and fresh directories:

```sh
production_out=$(mktemp -d /tmp/transit-production.XXXXXX)
preview_out=$(mktemp -d /tmp/transit-preview.XXXXXX)
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --env "" --outdir "$production_out"
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --env preview --outdir "$preview_out"
```

Inspect bundle/gzip sizes and binding names, never credential values. Expected bindings: `REGION_FEED_HUB`, `TRANSIT_ARTIFACTS`, `MCP_RATE_LIMITER`, `ANALYTICS`, `ASSETS`, plus public origin/allowlist, environment and dark mode variables. A bundle size is not an artifact working-set measurement. A local readiness check is startup evidence only for the local Worker.

README, docs/SEO metadata, `llms.txt`, `/info`, privacy and terms describe the stable global catalog and conditional data truthfully. Landing-page/OG/registry copy already limits live coverage to DC/NYC and keeps SF in development; no live SF marketing was restored. Free anonymous access, no client credential requirement, no account/session store, and finite aggregate telemetry remain unchanged. The [rollout guide](sfbay-rollout.md) lists the remaining authoritative ingestion/uploader work and exact conditional activation sequence.
