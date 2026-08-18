# Task 12 Report: Stateless OAuth Environment Configuration

## Outcome

Production and preview now have distinct, production-shaped OAuth Provider
configuration without activating the rollback Durable Object. The Worker keeps
the original `v1` migration and inactive `MetroMcpAgent` export/source while
the deployed request shape contains only `OAUTH_KV`, assets, public variables,
and approval-gated secrets.

## Authorized inventory and resources

- Read-only inventory confirmed the linked Cloudflare account is `Aarekaz`;
  the configured account identifier was preserved unchanged.
- User-authorized production namespace: `OAUTH_KV`
  (`d93416b961b0442b80c04b0081105ff6`).
- User-authorized preview namespace: `OAUTH_KV_preview`
  (`e66115284977469fa58e5537976647f7`).
- The prior OAuth, rate-limit, and Durable Object namespaces were not deleted,
  renamed, or otherwise mutated.
- The independently authorized GitHub OAuth app `Metro MCP Server Preview`
  uses public client ID `Ov23li2oFCt24EJJ0X1O`, homepage
  `https://metro-mcp-preview.anuragd.me`, and exact callback
  `https://metro-mcp-preview.anuragd.me/callback`. Wildcard callback matching
  and device flow are disabled. No client secret was generated.

## TDD evidence

The deployment tests were written before the binding edit.

1. Initial RED: five failures proved the top-level config lacked the canonical
   variable set and strict-fetch flag, retained all three legacy bindings, and
   had no named preview environment.
2. Intermediate RED: the preview dry-run exposed inheritance of the production
   custom domain and the missing independent preview GitHub client. A focused
   test locked `env.preview.routes` to `[]`; the client-isolation test remained
   red rather than silently reusing production credentials.
3. Final GREEN: after the approved preview app supplied its public ID, the
   focused deployment suite passed 55/55.

The tests now verify exact production/preview origins and callbacks, exact and
distinct real KV IDs, the independent preview GitHub public client, absence of
active `MCP_SESSION`, `RATE_LIMIT_KV`, and `OAUTH_CLIENTS` bindings, the exact
original migration, absence of `deleted_classes`, strict public fetches, and
retention of assets, observability, source maps, and the production route.

## Final configuration

- Production origin: `https://metro-mcp.anuragd.me`.
- Preview origin: `https://metro-mcp-preview.anuragd.me`.
- Each environment has matching Host/Origin allowlists, exact `/callback`, and
  the correct `ENVIRONMENT` value.
- Preview explicitly sets `routes: []`, preventing a preview command from
  inheriting and reassigning the production custom domain. Preview DNS remains
  approval-gated.
- `global_fetch_strictly_public` was added alongside `nodejs_compat`.
- The active Durable Object binding and the two retired KV bindings were
  removed from actual and example configuration. The inactive legacy session
  KV type remains only as a rollback data shape and has no Wrangler binding.
- No `VERSION`/`APP_VERSION` variable was invented. The codebase has no such
  runtime contract; Task 13 owns the static 5.0.0 and MCP 2026 metadata update.

## Verification

- `bunx vitest run tests/unit/config.test.ts`: 55/55 passed.
- `bun run type-check`: both TypeScript programs passed.
- `bun run test:unit`: 316/316 passed.
- `bun run test:workers`: 25/25 passed against the assembled Worker and real
  local Provider KV behavior. Upstream packages emit known missing-source
  sourcemap notices only.
- `bun run test`: 341/341 combined tests passed.
- `bun install --frozen-lockfile`: passed with no changes across 521 packages.
- Production Wrangler dry-run: passed; only production `OAUTH_KV`, assets, and
  the intended public variables were listed.
- Preview Wrangler dry-run: passed without environment-inheritance warnings;
  only preview `OAUTH_KV`, assets, and intended preview public variables were
  listed.
- Both JSONC files parse; `git diff --check` passed.
- Non-map production/preview bundles and active request sources contain no
  `MCP_SESSION`, `env.MCP_SESSION`, `RATE_LIMIT_KV`, `OAUTH_CLIENTS`, old KV
  IDs, or `MetroMcpAgent.serve` references. `src/index.ts` and `src/mcp` contain
  no `getByName`/`getById` namespace lookup. Generic Durable Object helper code
  may remain in the bundle through the intentionally retained rollback class,
  but no active binding or request path can resolve it.
- `src/index.ts` and `src/mcp-agent.ts` are unchanged from the Task 12 base.
  `export { MetroMcpAgent }`, migration tag `v1`, and
  `new_sqlite_classes: ["MetroMcpAgent"]` remain; no deletion migration exists.

## Deferred approval-gated actions

No secret was read, printed, generated, or set. Generating the preview GitHub
client secret, setting `GITHUB_CLIENT_SECRET`, independently generating and
setting stable production/preview `MCP_REQUEST_STATE_KEY` values, setting the
remaining per-environment secrets, adding preview DNS/custom domains,
uploading/deploying either environment, deleting old resources, pushing, and
opening a PR all remain separate approval-gated actions.

DONE
