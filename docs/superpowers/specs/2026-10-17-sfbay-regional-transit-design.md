# SF Bay Regional Transit Design

Approved 2026-10-17.

Transit MCP will add the permanent public region id `sfbay` through a reusable GTFS/GTFS-Realtime architecture. Static feeds compile deterministically into versioned artifacts. A region-neutral `RegionFeedHub` owns realtime polling and quota enforcement so upstream request volume never depends on rider traffic. Existing DC and NYC behavior remains isolated and contract-tested.

The first implementation stays dark by default. It adds region identity, static parsing and artifacts, realtime normalization and freshness semantics, a regional service boundary, MCP schema support, and deployment bindings. Production activation, secrets, legal acceptance, and live 511 data capture remain explicit owner-controlled rollout steps.

Accepted one-way decisions:

- public region id: `sfbay`
- durable object class: `RegionFeedHub`
- stable 511 ids are exposed verbatim when primary-source verification confirms uniqueness
- static artifacts live in R2
- telemetry is aggregate upstream health only
- rollout modes: `off`, `dark`, `on`, `suspended`

Required invariants:

- no user request triggers a 511 fetch
- missing 511 configuration never breaks DC or NYC
- stale or unavailable realtime degrades to schedules with explicit warnings
- source attribution accompanies every Bay Area result
- DC/NYC observable behavior and strict schemas remain compatible
- feeds and operator text are untrusted input

