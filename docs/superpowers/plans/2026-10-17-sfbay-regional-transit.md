# SF Bay Regional Transit Implementation Plan

Spec: `docs/superpowers/specs/2026-10-17-sfbay-regional-transit-design.md`

## Task 1: Establish regional identity and optional configuration

Add `PublicCity`, rollout modes, the `sfbay` manifest, and optional 511 configuration. Prove missing configuration leaves legacy behavior intact.

## Task 2: Build deterministic static GTFS primitives

Add RFC 4180 CSV parsing, service-time parsing, identity/URI rules, route-mode mapping, deterministic artifact schemas, and synthetic fixtures.

## Task 3: Build realtime normalization

Decode GTFS-Realtime, join updates to static data, classify freshness, sanitize text, and expose explicit warnings for stale, malformed, empty, and unavailable feeds.

## Task 4: Implement quota-independent regional service

Add the polling budget, upstream redaction, hub core, Durable Object shell, R2 artifact reader, and regional service RPC boundary. User queries must never fetch upstream.

## Task 5: Add the Bay Area MCP surface

Branch Bay Area handling before legacy station shortcuts, extend existing tools additively, add `get_vehicle_positions`, preserve strict DC/NYC schemas, and require attribution.

## Task 6: Deployment, application, and documentation

Add dark-by-default bindings and migrations, render freshness and attribution, update catalog/docs/version, and build the generated app.

## Task 7: Verification and rollout evidence

Run focused tests, unit and worker suites, type checks, dry-run deploys, and document remaining live-source/legal gates. Do not deploy.

