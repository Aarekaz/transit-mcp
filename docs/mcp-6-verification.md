# Metro MCP 6.0 verification record

Date: August 25, 2026 (America/New_York)

Release: Metro MCP `6.0.0`. The original pre-verification base was
`7ef18cadee2153cf14a03e26830ddc55fd52bd2a`; the final reviewed runtime commit
deployed to preview was
`d00e32c3e8f961b3027ac86cde570cd24b14a0e8`.

Protocol: MCP `2026-07-28`, anonymous stateless HTTP

This record separates deterministic repository gates, a real local Worker,
preview deployment, production deployment, and external cleanup. Task 7 changed
only the independently configured Cloudflare preview Worker and a temporary
Codex MCP entry that was removed after acceptance. Task 8 subsequently merged
the reviewed release, deployed the same runtime to production, and completed
the separately approved OAuth and obsolete-state cleanup recorded below.

## Environment and secret boundary

| Component | Version |
| --- | --- |
| Bun | `1.3.14` |
| Node.js | `26.7.0` |
| Wrangler | `4.122.0` |
| Vite | `8.2.1` |
| Playwright | `1.62.1` |
| Vitest | `4.1.10` |
| MCP conformance | `0.2.0-alpha.11` |

Local Worker checks used an ignored, mode-`0600` `.dev.vars` with exactly these
names: `MCP_PUBLIC_ORIGIN`, `MCP_ALLOWED_HOSTNAMES`,
`MCP_ALLOWED_ORIGIN_HOSTNAMES`, `MCP_REQUEST_STATE_KEY`, `WMATA_API_KEY`, and
`ENVIRONMENT`. The WMATA value was transferred in-process from the existing
local checkout without displaying it. `MCP_REQUEST_STATE_KEY` was freshly
generated from 48 random bytes. No secret value, request state, transit request
argument, or stale bearer canary is recorded here.

## Source-linked verification matrix

| Boundary | Status on this branch | Durable evidence and contract source |
| --- | --- | --- |
| Automated repository | **Passed** | [package scripts](../package.json), [bounded-body unit tests](../tests/unit/mcp-http-handler.test.ts), [rate-before-read routing test](../tests/unit/index-routing.test.ts), [assembled Workerd tests](../tests/workers/mcp-worker.test.ts), and [browser configuration](../playwright.apps.config.ts) |
| Local-live Wrangler | **Passed before the handler remediations; not rerun for the current handler delta** | The real `127.0.0.1:8787` matrix below ran on the pre-remediation verification tree. Current body-limit and bounded-allocation behavior passed the linked unit and Workerd suites, which is automated runtime evidence rather than a new local-live run. Runtime entrypoints: [Worker dispatch](../src/index.ts), [MCP handler](../src/mcp/http-handler.ts), [route normalizer](../src/route-normalizer.ts), and [direct conformance runner](../scripts/run-conformance.sh). |
| Preview-live | **Passed** | The exact reviewed commit above was deployed only to the distinct preview environment declared in [Wrangler configuration](../wrangler.jsonc). The live results below exercise [Worker dispatch](../src/index.ts), [the MCP handler](../src/mcp/http-handler.ts), [the public router](../src/public-handler.ts), [the catalog](../src/mcp/server.ts), and [the rate limiter](../src/rate-limit.ts). |
| Production-live | **Passed** | PR [#16](https://github.com/Aarekaz/metro-mcp/pull/16) merged as `8407d2a841a041f55115d44a8dca87411584fa60`; the exact release tree was deployed and passed the production matrix below. Production routes and bindings are in [Wrangler configuration](../wrangler.jsonc). |
| External OAuth cleanup | **Passed after owner confirmation** | The irreversible ownership and cleanup gate from the [approved design](superpowers/specs/2026-08-21-metro-mcp-6-anonymous-design.md#cleanup-and-rollback) and [Task 8 plan](superpowers/plans/2026-08-21-metro-mcp-6-anonymous.md#task-8-review-merge-deploy-production-and-retire-external-oauth-state) was completed by exact name/ID, then both environments were reverified. |

“Passed” in one row does not imply another row passed. In particular, local
evidence is not presented as preview, production, client-marketplace, or
external-cleanup evidence.

## Deterministic repository gates

The command contract is defined in [package.json](../package.json). The body
boundary's focused source-linked evidence is in
[the handler unit suite](../tests/unit/mcp-http-handler.test.ts),
[the routing-order suite](../tests/unit/index-routing.test.ts), and
[the assembled Workerd suite](../tests/workers/mcp-worker.test.ts).

| Gate | Exact result |
| --- | --- |
| `bun install --frozen-lockfile` | passed; 407 packages installed; no lockfile changes |
| `bun run type-check` | passed; all four TypeScript projects |
| `bun run test:unit` | passed; 26 files, 365 tests |
| `bun run test:workers` | passed; 1 file, 30 tests |
| `bun run test` | passed; Apps build, 365 unit tests, 30 Workerd tests |

Workerd emitted only the known missing-source sourcemap messages from pinned
third-party packages. The messages do not identify an application test failure.

### Rate-limit recovery timing

The inherited recovery test had previously passed its `200`, `200`, `429`
boundary and then exceeded its 35-second test timeout while Workerd was idle
across the next epoch. One earlier failure reported a roughly 994-second jump in
the test clock. The observable contract was not relaxed: the test still requires
two admitted requests, the exact third-request denial, entry into a later
10-second epoch, and a recovered `200`.

The observable recovery contract and public heartbeat scheduler live in
[the Workerd suite](../tests/workers/mcp-worker.test.ts); the production
limiter call remains before body handling in [the Worker entry](../src/index.ts).

The recovery wait now keeps the public Worker event loop scheduled with
successful `/info` requests at intervals of at most 250 milliseconds. It also
requires at least one second to remain in the selected starting epoch. Five
consecutive focused Workerd repetitions passed with test-body durations of
9.34, 5.40, 3.13, 5.07, and 5.65 seconds. The independent Workerd and combined
gates passed on the verification commit. After the formal security scan found
the body-size issue described below, both gates passed again on the remediation
tree with the updated counts.

### Transit Board determinism and browser acceptance

`public/apps/transit-board.html` was removed from the build output before each
of two independent `bun run build:apps` invocations. Both clean builds, and the
checked-in artifact, were byte-identical:

- size: `392515` bytes;
- SHA-256: `5ad6ba1b0d1d580682a015cf93179e465195d8331975e95e3c028ca629f49c34`.

Before the security scan, `bun run test:apps` ran three independent times with repository-managed
Chromium, one worker, and zero retries. The final-review tree ran three more
independent full passes after adding the static header contract. Every run
passed all 62 tests. These runs
cover all thirteen dedicated tool renderers, the five visual families,
desktop/mobile legal pages, real Worker-backed `/`, `/docs/`, `/privacy/`,
`/terms/`, `/support/`, and `/info` routing, keyboard/focus and overflow
behavior, host lifecycle, hostile text, and the positive self-checks for every
security observer. The final body-limit hardening changes only the Worker
request handler and its server-side tests. Two clean remediation builds
reproduced the same size and hash above, and three more zero-retry browser runs
each passed all 62 tests.

The generated artifact is [Transit Board](../public/apps/transit-board.html),
its build inputs are under [the Transit Board application](../apps/transit-board/),
and the acceptance sources are [the Apps suite](../tests/apps/transit-board.spec.ts)
and [legal-page suite](../tests/apps/legal-pages.spec.ts).

## Production and preview dry-runs

The following commands exited after creating local bundles; neither command
deployed a Worker:

```bash
bunx wrangler deploy --dry-run --env="" --outdir <fresh-production-directory>
bunx wrangler deploy --env preview --dry-run --outdir <fresh-preview-directory>
```

The environment-specific routes, variables, assets, rollback migration, and
rate-limit namespaces are source-controlled in
[wrangler.jsonc](../wrangler.jsonc) and guarded by
[configuration tests](../tests/unit/config.test.ts).

| Inventory | Production | Preview |
| --- | --- | --- |
| asset inventory | 24 served assets plus the `_headers` configuration file; Wrangler read 25 files | 24 served assets plus the `_headers` configuration file; Wrangler read 25 files |
| rate limiter | `MCP_RATE_LIMITER`, 300 requests / 60 seconds | `MCP_RATE_LIMITER`, 300 requests / 60 seconds |
| namespace ID in configuration | `2026082101` | `2026082102` |
| public origin | production custom domain | preview custom domain |
| public variables | origin, Host allowlist, browser-Origin allowlist, environment | origin, Host allowlist, browser-Origin allowlist, environment |
| OAuth/provider/KV binding | absent | absent |

The exact generated-header contract is checked in as
[`public/_headers`](../public/_headers). Its wildcard rule applies
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and the restricted
Permissions Policy to every static response. `/privacy/*`, `/terms/*`, and
`/support/*` add a scriptless CSP; `/` and `/docs/*` retain separate policies
for their existing inline interactions. Unit tests parse the deployed file,
and the browser suite observed the merged legal-page headers from local
Wrangler. Static assets remain asset-first; no broad Worker-first override was
enabled.

Both bundles retain the inactive `MetroMcpAgent` export and the original `v1`
`new_sqlite_classes` migration for rollback. Neither source map contains a
deleted `src/oauth/` module or the removed conformance proxy. Each minified
bundle contains exactly one allowed transitive vendor string,
`cloudflare.workers-oauth-provider.verified-context.v1`, from the pinned Agents
handler shared by the anonymous server and rollback class. There is no
application provider dependency, route, dispatch context, variable, KV binding,
or OAuth implementation behind that inert marker.

## Real local Worker acceptance

Wrangler ran locally on `127.0.0.1:8787` with the exact loopback origin and
allowlists from `.dev.vars`. Because the checked-in production custom-domain
route otherwise changes the Worker-visible request origin during local
emulation, the local-only invocation set `--local-upstream 127.0.0.1:8787`,
`--local-protocol http`, and `--upstream-protocol http`. No source or production
trust check was changed for the harness.

The exercised behavior comes from [the Worker entry](../src/index.ts),
[public routing](../src/public-handler.ts), [server metadata](../src/server-info.ts),
[the MCP catalog](../src/mcp/server.ts), and
[the request handler](../src/mcp/http-handler.ts). Equivalent trust and protocol
boundaries are locked in [Workerd](../tests/workers/mcp-worker.test.ts).

The following matrix passed against the running Worker:

| Surface | Observed result |
| --- | --- |
| `/info` | `6.0.0`, protocol `2026-07-28`, authentication `none`, catalog `13/3/3` |
| legal pages | privacy, terms, and support returned `200` |
| modern discovery | anonymous `server/discover`; exact 13 tools, 3 resource templates, and 3 prompts |
| live transit | real WMATA station predictions for `A01`; public MTA station predictions for `127` |
| resources/prompts/App | station resource, service-briefing prompt, and Transit Board App resource succeeded |
| progress | two ordered progress notifications followed by the result |
| cancellation | stream reader cancellation and request abort stopped the in-flight exchange |
| modern MRTR | Times Square produced signed `v1` `input_required`; an allowlisted candidate completed |
| compatibility | MCP 2025 stateless tools list exposed the same 13 tools |
| alias | modern discovery succeeded through `/sse` |
| unsupported methods/routes | all eight cases returned `405` with `Allow` |
| stale bearer | response was byte-equivalent to no bearer and had no `WWW-Authenticate` header |
| retired OAuth routes | all eight former routes returned `404` |

Captured Wrangler output was searched for the exact stale-bearer canary and a
representative station-search argument canary. Neither value appeared. The
captured application telemetry contained only its documented allowlisted
fields, while Wrangler emitted ordinary method/path/status summaries.

## Frozen conformance runner

The required direct command ran against the same local Worker:

```bash
MCP_CONFORMANCE_TARGET_URL=http://127.0.0.1:8787/mcp ./scripts/run-conformance.sh
```

The checked-in [direct runner](../scripts/run-conformance.sh) invokes the frozen
package without an authentication proxy. The upstream runner and its current
server-test contract are maintained by the
[official MCP conformance project](https://github.com/modelcontextprotocol/conformance).

The frozen manifest listed 69 server scenarios and 50 requirement scenarios.
The runner exited `0` and its generated checks contained 105 successes, 66
failures, 4 warnings, 1 informational result, and 1 skipped result. The runner's
scored summary was 77 passed and 30 failed across 37 scenarios; 13 scenarios
were run but not scored. A second fresh Worker and fresh artifact directory
produced the same 105/66 check result, ruling out rate-limit exhaustion as the
cause.

This is execution evidence, not a zero-failure conformance claim. The failures
are dominated by diagnostic product fixtures that the generic runner expects
but Metro MCP intentionally does not advertise: for example
`test_simple_text`, `slow_compute`, `greet`, task-extension tools, test-only
resources, and test-only prompts. Adding those names would violate the exact
13/3/3 public catalog. An example failed `tools-call-simple-text` product check
is paired with a successful `wire-schema-valid` check. The local-upstream
harness also canonicalized the runner's invalid Host probe; the Workerd request
boundary independently verifies invalid Host, browser Origin, and URL origin
rejection. Task-extension checks are inapplicable because Metro MCP does not
advertise the task capability. Therefore the frozen runner is useful as a
recorded compatibility probe, but its diagnostic-fixture total is not the
release's product-specific acceptance gate.

## Preview deployment and live acceptance

The final reviewed runtime commit
`d00e32c3e8f961b3027ac86cde570cd24b14a0e8` was deployed with
`bunx wrangler deploy --env preview` only. Cloudflare created preview version
`bf79177a-1929-4508-93d0-b38ff9f1c91a` and made it the current independently
configured `metro-mcp-preview` deployment. Production was not deployed or
modified. The commit that adds this evidence record changes documentation only;
the deployed Worker source and static assets remain exactly those from the
runtime commit above.

The deployed preview inventory matched [Wrangler configuration](../wrangler.jsonc):
the preview custom domain and public origin, Host and browser-Origin allowlists,
environment marker, 24 served assets plus the `_headers` configuration file,
and `MCP_RATE_LIMITER` at 300 requests per 60 seconds. The required
`MCP_REQUEST_STATE_KEY` and `WMATA_API_KEY` encrypted secrets remained present.
At initial preview acceptance, the retired `GITHUB_CLIENT_SECRET` and
`JWT_SECRET` encrypted values were still stored pending the separate
post-production cleanup gate; no code path read them. They were removed during
the approved cleanup recorded below. No OAuth public variable, OAuth route,
provider binding, or KV binding was deployed.

The live preview matrix exercised the implementation linked in the
[source-linked verification matrix](#source-linked-verification-matrix):

| Preview surface | Observed result |
| --- | --- |
| `/info` and legal pages | `200`; version `6.0.0`, protocol `2026-07-28`, authentication `none`, catalog `13/3/3`; privacy, terms, and support returned scriptless HTML with the intended CSP and shared defenses |
| modern discovery and catalog | anonymous discovery completed; exact 13 tools, 3 resource templates, and 3 prompts |
| Transit Board App | public and `ui://metro-mcp/transit-board.html` bytes matched the exact `392515`-byte deterministic artifact and SHA-256 `5ad6ba1b0d1d580682a015cf93179e465195d8331975e95e3c028ca629f49c34` |
| real transit | WMATA `A01` and public MTA `127` prediction calls completed |
| resource and prompt | NYC station resource and DC service-briefing prompt completed |
| progress and cancellation | at least two ordered progress notifications preceded the result; a client-aborted follow-up left the next discovery request healthy |
| MRTR | signed `v1` Times Square `input_required` state completed after an allowlisted selection |
| compatibility and alias | MCP 2025 headerless tools list exposed the same 13 tools; modern discovery completed through normalized `/sse` |
| OAuth retirement and stale bearer | all eight former OAuth routes returned `404`; stale bearer and anonymous discovery were byte-equivalent with no challenge |
| trust and methods | invalid browser Origin and the noncanonical workers.dev Host/origin returned `403`; all eight unsupported method/session cases returned `405`; canonical preflight returned `200` without an authentication challenge |
| request-body boundary | exact 1 MiB `/mcp` reached the SDK; oversized `/mcp` and normalized `/sse` returned deterministic `413` |

Cloudflare performs the observed scheme canonicalization before Worker dispatch;
the [assembled Workerd suite](../tests/workers/mcp-worker.test.ts) separately
proves the Worker-visible noncanonical-origin `403` contract.

### Preview conformance and Codex client

The conformance and Codex-client results in this subsection were collected on
the earlier preview version `d8fb4612-da66-4932-b69a-335b21783b82` from runtime
commit `085bdc39f3ca90c138d73233f73dffcff6a41db9`; they were not rerun after the
bounded-body remediations. The exact-head live matrix above independently
reverified discovery, catalog, representative real DC/NYC calls, compatibility,
and cancellation recovery on the current runtime version.

The same frozen [direct conformance runner](../scripts/run-conformance.sh)
targeted the preview `/mcp` endpoint. It listed 69 server scenarios and ran 50
requirement scenarios. The raw checks were 94 passed and 72 failed. The scored
summary was 76 passed and 31 failed across 37 scenarios; the 13 run-but-unscored
extension/pending scenarios contributed 18 passed and 41 failed checks. As in
the local run, the runner is diagnostic rather than the product gate: failures
remain dominated by generic fixture names and unadvertised task extensions that
cannot be added without violating the exact production catalog. The small
local/live count difference is recorded rather than normalized away.

A fresh ephemeral Codex client used a temporary anonymous
`metro-mcp-v6-preview` MCP entry with no bearer-token environment variable,
headers, OAuth flow, login prompt, or stored credential. It completed
`get_station_predictions` for DC `A01` and NYC `127`; the final client result
reported 6 and 50 predictions respectively. The temporary entry was removed,
and a subsequent lookup confirmed it no longer exists. Codex logged a
non-blocking shutdown diagnostic when its generic streamable-HTTP client sent
`DELETE` with a session ID to the stateless server and received `400`; both
requested calls and the final result had already completed. Claude client
acceptance was explicitly user-waived for this gate and is not claimed passed.

### Preview rate-limit calibration and logs

The calibration and canary-log results in this subsection were also collected
on preview version `d8fb4612-da66-4932-b69a-335b21783b82`. The rate-limiter
configuration and ordering are unchanged at the final runtime commit; the full
repository gate and exact-head live matrix reverified ordinary admission and
fail-closed routing, but did not repeat the destructive quota-exhaustion or log
tail.

Three legitimate parallel bursts each issued eight MCP POSTs: discovery, all
four catalog/list surfaces, Transit Board App loading, and one DC plus one NYC
prediction call. Every request passed. The bursts completed in 971, 384, and
379 milliseconds. The measured maximum legitimate burst was therefore 8, and
`max(10 * 8, 300)` remains 300 requests per minute. No real upstream constraint
was observed during the live calls. The public WMATA portal says keys are rate
limited but does not publish this account's numeric service-tier quota. Without
an account-specific number or an observed quota failure, there was no
evidence-based lower threshold to select, so
[the configured limiter](../wrangler.jsonc) was not changed merely to create
configuration churn.

After a clean 65-second window, a strictly sequential preview probe admitted
301 `server/discover` requests and denied attempt 302. The denied follow-up was
exactly HTTP `429` with JSON-RPC code `-32029`, message `Rate limit exceeded`,
`id: null`, `Retry-After: 60`, JSON content type, `X-Request-ID`, and
`X-Content-Type-Options: nosniff`. Public `/info` heartbeats remained `200`, and
the first MCP request after 65,053 milliseconds recovered with `200`.

Before that sequential proof, intentionally concurrent probes admitted 360 and
then 1,200 requests without a denial. This is bounded evidence of Cloudflare's
documented permissive, eventually consistent, per-machine cache behavior, not
an exact-accounting claim. The release threshold remains the configured policy;
it is not represented as a hard global firewall.

A version-pinned, self-IP, 4xx-only tail reproduced first denial at request 302.
Both denied application log entries contained only `correlationId`, `alias`,
`durationMs`, and `statusClass`; they contained no era, protocol, MCP method,
MCP name, or upstream field, proving the limiter returned before SDK dispatch.
An exact search for the stale-bearer and representative transit-argument
canaries returned zero events. A separate `mcpMethod` positive-control search
captured both corresponding allowlisted application logs, establishing that
the tail was active. Sampled events reported successful Worker outcomes with no
exceptions; no request body, bearer value, transit argument, signed request
state, stack trace, or response body appeared in application telemetry.

After updating this record, the final focused legal/server/header/release-docs
slice passed 4 files and 53 tests. Type checking passed all four projects; the
full unit suite passed 26 files and 365 tests; the Workerd suite passed 1 file
and 30 tests; and the combined Apps-build/unit/Workerd gate passed.
The new assembled Workerd case completes the signed modern station-selection
MRTR flow with an allowlisted candidate. Two additional Apps builds
remained byte-identical at 392,515 bytes and SHA-256
`5ad6ba1b0d1d580682a015cf93179e465195d8331975e95e3c028ca629f49c34`.
Three additional full managed-Chromium runs each passed all 62 tests. Fresh
production and preview dry-runs each exited `0`, read 25 files including the
special `_headers` configuration, and reported only the intended public
bindings. These were local validation commands; neither dry-run deployed a
Worker and production was not changed.

## Production deployment, cleanup, and post-cleanup acceptance

PR [#16](https://github.com/Aarekaz/metro-mcp/pull/16) merged the reviewed
release as `8407d2a841a041f55115d44a8dca87411584fa60`. The exact merge tree was
installed with the frozen Bun lockfile, type-checked, dry-run, and deployed to
production as version `63109890-bb76-4480-ba90-b3ecfef4e34a`. Production then
passed the same 12-group acceptance matrix used for exact-head preview. A
version-pinned, self-IP production tail observed two read-only canaries return
`200`; application logs contained only the allowlisted telemetry fields, no
stale-bearer canary, and no exception. Cloudflare's outer invocation record
contained ordinary edge metadata and represented the authorization field as
redacted; it was not an application log.

After this acceptance evidence, the owner gave the plan's required final
confirmation for irreversible cleanup. The approved broader scope also removed
the obsolete pre-6.0 session and KV rate-limit state. Cleanup and its immediate
verification completed on August 25, 2026, by `2026-08-25T19:57:48Z`. No
secret value was read or recorded.

The following exact retired Cloudflare resources were deleted:

| Resource type | Environment/name | ID when applicable |
| --- | --- | --- |
| encrypted secret | production `GITHUB_CLIENT_SECRET` | name only |
| encrypted secret | production `JWT_SECRET` | name only |
| encrypted secret | preview `GITHUB_CLIENT_SECRET` | name only |
| encrypted secret | preview `JWT_SECRET` | name only |
| OAuth provider KV | `OAUTH_KV` | `d93416b961b0442b80c04b0081105ff6` |
| OAuth provider KV | `OAUTH_KV_preview` | `e66115284977469fa58e5537976647f7` |
| legacy client-registration KV | `OAUTH_CLIENTS` | `44f6224b68354c24bf071e2b53b13dbb` |
| legacy client-registration KV | `OAUTH_CLIENTS_preview` | `7d10b069531a459cb56ed59220ede55b` |
| obsolete session KV | `MCP_SESSIONS` | `5d8c66d201ed4fa3ac00f7acdb930632` |
| obsolete session KV | `MCP_SESSIONS_preview` | `da9efc735f9a49f7ba1827ebf5d33d29` |
| obsolete KV rate limit | `RATE_LIMIT_KV` | `93885a8c949b4298a7d866e2cef408b3` |
| obsolete KV rate limit | `RATE_LIMIT_KV_preview` | `7cbeddccb3a94346b4452f40bc692b39` |

GitHub accepted and completed deletion jobs for the three Aarekaz-owned Metro
OAuth Apps. Direct authenticated visits to every former settings URL returned
GitHub's `Page not found` result:

| GitHub OAuth App | Application ID |
| --- | --- |
| `Metro MCP Server` | `3308666` |
| `Metro MCP Server Preview` | `3792382` |
| `Metro MCP Server Local` | `3792616` |

Deleting the two retired secrets in each environment created secret-triggered
Worker versions without changing the script. Production deployment
`a490efe0-0364-4387-8180-7aebbe5b877e` now serves version
`f33bb8df-77c8-4b8f-9fb8-0456af6c3d2b`; preview deployment
`e8dcfd8c-6719-4e8e-80cc-3af51e58b7c9` serves version
`1729a618-a726-4213-9982-8e7d472f0bee`. Both current versions report script
ETag `a8976347cc67b79e4e9b5f864fcf7a5b2eb257a8f3141d20a8c7874194cfe225`.

Fresh post-cleanup inventories proved that both Workers retain only
`MCP_REQUEST_STATE_KEY` and `WMATA_API_KEY` as encrypted secrets. The current
production version retains `MCP_RATE_LIMITER` namespace `2026082101`; preview
retains namespace `2026082102`. Both policies remain 300 requests per 60
seconds. The account KV list contains only unrelated `KHANA_KV`,
`RAINDROP_AUTH_KV`, and `RAINDROP_AUTH_KV_preview`; none was changed.

The full post-cleanup matrix passed 12 of 12 groups independently against both
`https://metro-mcp.anuragd.me` and
`https://metro-mcp-preview.anuragd.me`:

| Post-cleanup surface | Production | Preview |
| --- | --- | --- |
| `/info`, legal/support pages, and security headers | passed | passed |
| modern anonymous discovery and exact `13/3/3` catalog | passed | passed |
| Transit Board public/MCP bytes and deterministic SHA-256 | passed | passed |
| representative resource and prompt | passed | passed |
| real WMATA `A01` and public MTA `127` predictions | passed | passed |
| signed MRTR Times Square selection | passed | passed |
| progress, cancellation recovery, MCP 2025, and `/sse` | passed | passed |
| stale bearer equivalence and all eight OAuth-route `404`s | passed | passed |
| trust, method, preflight, exact 1 MiB, and oversized `413` boundaries | passed | passed |

External OAuth rollback is no longer one click: returning to 5.0 would require
recreating the deleted GitHub Apps, secrets, and KV namespaces. The accepted
6.0 service does not depend on any of them.

## Source and security review

The active trust path is source-linked as follows:

1. [Route normalization](../src/route-normalizer.ts) admits only exact MCP
   routes and methods.
2. [The Worker entry](../src/index.ts) enforces public URL, Host, and optional
   browser-Origin trust, then calls [the rate limiter](../src/rate-limit.ts)
   before the MCP body handler.
3. [The MCP handler](../src/mcp/http-handler.ts) enforces the body ceiling,
   strips stale `Authorization`, and dispatches through a request-scoped SDK
   server while preserving cancellation.
4. [Telemetry](../src/telemetry.ts) is allowlisted and cannot serialize request
   bodies, arguments, bearer values, or signed request state.
5. [The server](../src/mcp/server.ts) binds five-minute HMAC request state to
   the MCP method, tool, query, and candidate IDs.

Application source, examples, package manifests, [Wrangler configuration](../wrangler.jsonc),
and both dry-run bundles were reviewed for the removed provider package,
provider dispatch, OAuth/KV bindings, GitHub client variables, redirect/JWT
variables, legacy-token configuration, proxy/token injection, and deleted OAuth
source modules. No application-level reintroduction was found; only the exact
inert transitive vendor marker described above remains in each bundle.

### Durable sanitized scan record

This checked-in section is the durable, secret-free evidence pointer for the
formal scan; the scanner's temporary artifact directory is intentionally not a
repository dependency. Scan
`7947e3eb0762a88eed3091d1713b79ed23da8fb8_20260822T234214Z_y3uuzowa`
covered the complete changed-file inventory through
[commit `7947e3eb`](https://github.com/Aarekaz/metro-mcp/commit/7947e3eb0762a88eed3091d1713b79ed23da8fb8),
starting at `d70c5754ac1b439a9f0359ae6245a4c402b8fb41`. It reported one
high-confidence, medium-severity finding and no other reportable finding.
Occurrence `occ_f37a72b420eb008b8b371660` reproduced an anonymous
`16,777,477`-byte `server/discover` body returning `200` through the pinned
whole-body parser.

The first remediation added the `1,048,576`-byte MCP POST ceiling at the shared
`/mcp` and normalized `/sse` handler. Its RED phase had five focused failures:
the declared trigger and absent, invalid, and ambiguous length forms reached
dispatch, and the bounded-reader abort behavior was missing. Declared overflow
then rejected before reading; unknown-length overflow cancelled; exact-limit
traffic reached the SDK; and quota denial still consumed no body.

Independent review then found that the first unknown-length implementation
retained one `Uint8Array` object per chunk. An isolated pre-fix diagnostic with
periodic full GC observed `638,976` bytes of RSS growth for one coarse overflow
chunk and `79,003,648` bytes for 300,000 one-byte chunks. Those figures diagnose
relative object amplification; they are not a production-memory measurement or
a committed absolute memory threshold.

The first review fix replaced that array with one preallocated 1 MiB-plus-sentinel
backing store. Follow-up security validation then found that every slow admitted
POST reserved the full ceiling before receiving a byte and that already-aborted
streamed POSTs could bypass the bounded reader. The final implementation in
[the shared handler](../src/mcp/http-handler.ts) validates a trustworthy declared
length before the abort branch, never dispatches an already-aborted streamed
body, and grows one backing store geometrically from zero to the same hard
limit. Deterministic [unit regressions](../tests/unit/mcp-http-handler.test.ts)
prove that an empty accumulator does not reserve the ceiling, 300,000 tiny
chunks require fewer than 32 growth operations, and overflow stops at the
1,048,577-byte sentinel. The focused handler and cancellation slice passed 18 tests;
[Workerd](../tests/workers/mcp-worker.test.ts) still verifies exact `413`
responses through `/mcp` and `/sse`, no body-canary telemetry, and `200` at
exactly 1 MiB. [The routing test](../tests/unit/index-routing.test.ts) still
proves a `429` body is neither pulled nor cancelled. The original declared
16.8 MB trigger and the unknown-length variants therefore no longer reach SDK
parsing with unbounded application-owned storage.

## Known operational limits

Cloudflare documents that its
[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
is per-location, permissive, eventually consistent, and unsuitable for exact
accounting. The current key is the Cloudflare-provided client IP; shared NATs
can share quota and a single caller can use multiple egress addresses. The local
fallback key exists for emulator/tests, not production identity. The initial
policy is 300 requests per 60 seconds. Preview calibration retained that policy
because the largest measured legitimate burst was 8; the concurrent and
sequential exhaustion evidence above demonstrates why it must still be treated
as a permissive edge safeguard rather than exact accounting.

WMATA's current [developer portal](https://developer.wmata.com/products) does
not publish this account's numeric service-tier quota, and its
[Transit Data Terms of Use](https://developer.wmata.com/license) distinguish an
end-user application from exposing Transit Data through an API. Confirmation
of the account-specific quota and any required redistribution authorization
remains an external owner/legal operational condition; the acceptance tests do
not infer either one.

The independent 1 MiB request-body ceiling protects parsing memory per admitted
MCP POST. It intentionally leaves ample headroom over the small public 13/3/3
catalog requests. Requests above the ceiling receive HTTP `413`; this is a
compatibility limit, not a quota response.

Cloudflare's current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#memory)
document a 128 MB per-isolate memory ceiling, while its
[BYOB stream guidance](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreambyobreader/#common-issues)
warns that a read may legally yield only one byte. The geometrically growing
bounded allocation therefore does not depend on coarse runtime chunking and
does not reserve the full ceiling for a slow request that has not supplied it.
Stream objects and runtime internals remain platform-owned; the application
retains no per-chunk array.

## Deployed and external status

- Reviewed release and production deployment: **Passed**. PR
  [#16](https://github.com/Aarekaz/metro-mcp/pull/16) merged as `8407d2a`; the
  exact release tree passed production acceptance before cleanup.
- Current post-cleanup production-live acceptance: **Passed** on
  secret-triggered version `f33bb8df-77c8-4b8f-9fb8-0456af6c3d2b` with the
  unchanged release script.
- Current post-cleanup preview-live acceptance: **Passed** on secret-triggered
  version `1729a618-a726-4213-9982-8e7d472f0bee` with the unchanged release
  script.
- Exact-head pre-cleanup preview-live anonymous acceptance: **Passed** on
  preview version `bf79177a-1929-4508-93d0-b38ff9f1c91a` from reviewed runtime
  commit `d00e32c3`.
- Earlier Codex client acceptance, rate-limit calibration, and canary log scan:
  **Passed** on preview version `d8fb4612-da66-4932-b69a-335b21783b82` from
  runtime commit `085bdc39`; these are retained as historical evidence rather
  than relabeled as exact-head runs.
- Retired Cloudflare OAuth secrets, OAuth KV, obsolete Metro session/rate-limit
  KV, and all three Metro GitHub OAuth Apps: **Deleted after explicit owner
  confirmation**, with exact post-cleanup inventories and live acceptance
  recorded above.
- Claude client acceptance: **User-waived**, not passed.
- Marketplace submission and any remaining client-directory acceptance:
  **Pending**.

No pending marketplace or client-directory item above is claimed complete by
this production verification record.
