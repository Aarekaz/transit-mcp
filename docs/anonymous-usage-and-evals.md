# Anonymous usage and synthetic prompt evaluations

## Usage report

Preview the read-only SQL and its explicit filters without credentials or network access:

```sh
bun scripts/query-anonymous-usage.ts --start 2026-10-01 --end 2026-10-08 --environment production
bun scripts/query-anonymous-usage.ts --start 2026-10-01 --end 2026-10-08 --environment preview --exclude-client transit-prompt-evals
```

Dates are UTC, start inclusive and end exclusive, with a 31-day maximum. The environment is required and must be `production`, `preview`, `development`, or `test`. No clients are excluded by default. Repeat `--exclude-client` to exclude exact documented software categories from `src/telemetry.ts`; arbitrary client strings are not accepted. Unknown names remain `unclassified`, including synthetic traffic without an explicit recognized label.

Only `--execute` makes a request. It requires `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN` with Account Analytics Read access in the environment. Never put tokens in command arguments. The script submits a fixed `SELECT` to Cloudflare's account Analytics Engine endpoint; it does not use Wrangler or perform mutations. Errors suppress raw provider content and credentials. Check the dates, environment and credentials locally if a run fails. No production query is required for tests.

The query uses the existing `mcp_usage` schema, projects finite categories before results leave Cloudflare, groups by UTC day, method, tool, client, environment and HTTP status, and sums `_sample_interval`. It never selects the historical index or raw names. The normalized report includes tool-call totals, HTTP-successful tool calls, daily counts, tool/client/status/environment distributions, and a separate legacy-initialization total. The SQL uses [Cloudflare's sampling-weighted count](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) and documented [conditional functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/conditional-functions/).

These are estimates of recorded requests, not people, unique clients, sessions or proven successful transit answers. An HTTP 2xx response can contain tool errors. Missing telemetry, retention gaps and unlabelled synthetic traffic cannot be recovered or inferred. Historical rows remain compatible with the five-blob/one-double layout, but their identifiers are never read. No historical deletion is performed.

## Prompt evaluation harness

Run deterministic fixtures without network access or an LLM:

```sh
bun scripts/run-prompt-evals.ts --dry-run
```

The checked-in scenarios cover resolved synthetic home/work context, ambiguous endpoints, SF/DC/NYC journeys, stale departures, impossible routes, provider-text injection, future departure windows, observed vehicles and coverage discovery. The JSON contains intentionally partial example results sufficient for these assertions; they are not complete MCP output fixtures. Dates and references are synthetic and fixed. Client-resolved inputs are passed directly to tools; no personal-context store or geocoder is introduced.

For an explicitly selected local or approved remote endpoint:

```sh
bun scripts/run-prompt-evals.ts --endpoint http://localhost:8787/mcp
```

This sends only the checked-in read-only calls using modern MCP `2026-07-28`, JSON responses, and the explicit `transit-prompt-evals` client label. HTTPS is required outside loopback. Credentials, URL query parameters and redirects are rejected. No endpoint is implicit. The harness does not initialize a legacy session, follow elicitation requests, call paid models, or retry failures. A failing case exits with code 1; diagnostics contain only fixture IDs and fixed failure codes.

Endpoint replay requires the fixture's synthetic network and clock to reproduce every expectation. Ordinary public deployments can correctly fail these scenario expectations, particularly SF dark mode, dates outside an artifact window, or synthetic references absent from a real feed. Do not describe such failures as production regressions without inspecting the data contract. Unit tests separately validate every fixture input against the registered schemas and replay coverage discovery through the real SDK in memory.

The report's `toolSelectionAccuracy` measures supplied/scripted tool-name agreement. The exported `evaluatePrompt`/`runPromptEvals` functions can score an independently supplied synthetic observation trace, including deliberately wrong tool choices. The built-in replay already specifies each tool; its 100% agreement is **not model-selection accuracy**. No natural-language answer is generated or evaluated. Injection checks establish labelled, inert agency text only; they cannot prove an LLM will ignore that text. Routing correctness, complete schemas, factual provenance and launch readiness remain covered by the separate core, golden-route and MCP contract suites.
