import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const revision = '2026-07-28', refereeVersion = '0.2.0-alpha.11';

function inventoryErrors(profile, checks) {
  const errors = [];
  const identity = (scenario, id, fieldIssue) => JSON.stringify([scenario, id, fieldIssue ?? null]);
  const expected = new Map();
  for (const [scenario, entries] of Object.entries(profile.requiredChecks ?? {})) {
    for (const entry of entries) {
      const key = identity(scenario, entry.id, entry.fieldIssue);
      if (expected.has(key)) errors.push('Duplicate inventory identity');
      expected.set(key, entry);
    }
  }
  if (!expected.size || !Array.isArray(checks)) return ['Missing required inventory or records'];
  const seen = new Set();
  for (const check of checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check)
      || !['scenario', 'id', 'name', 'description', 'timestamp'].every(key => typeof check[key] === 'string' && check[key].length > 0)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(check.timestamp) || !Number.isFinite(Date.parse(check.timestamp))
      || !Array.isArray(check.specReferences) || !check.specReferences.every(ref => ref && typeof ref.id === 'string' && typeof ref.url === 'string')
      || (['FAILURE', 'WARNING'].includes(check.status) && (typeof check.errorMessage !== 'string' || !check.errorMessage))
      || (check.errorMessage !== undefined && typeof check.errorMessage !== 'string')) {
      errors.push('Malformed required check record'); continue;
    }
    const key = identity(check.scenario, check.id, check.details?.fieldIssue), entry = expected.get(key);
    if (!entry || seen.has(key)) errors.push(`Unknown or duplicate required check: ${check.scenario}/${check.id}`);
    else if (!entry.statuses.includes(check.status)
      || !Object.entries(entry.detailsEquals ?? {}).every(([key, value]) => check.details?.[key] === value)) errors.push(`Unexpected required branch: ${check.scenario}/${check.id}`);
    seen.add(key);
  }
  for (const key of expected.keys()) if (!seen.has(key)) errors.push(`Missing required check: ${key}`);
  return errors;
}

export function scoreProductConformance(profile, checks, evidence) {
  const requiredInventoryErrors = inventoryErrors(profile, checks);
  checks = Array.isArray(checks) ? checks.filter(check => check && typeof check === 'object') : [];
  const missingEvidence = Object.entries(profile.evidence).filter(([, expected]) =>
    !evidence.some(actual => actual.file === expected.file && actual.title === expected.title && actual.status === 'passed')).map(([name]) => name);
  const failures = checks.filter(check => check.status === 'FAILURE');
  const incompleteChecks = checks.filter(check => !['SUCCESS', 'FAILURE', 'WARNING', 'INFO'].includes(check.status))
    .map(({ scenario, id, status }) => ({ scenario, id, status }));
  const unclassifiedFailures = failures.filter(check => !profile.diagnosticChecks.some(known =>
    known.scenario === check.scenario && known.id === check.id && known.error === check.errorMessage
    && known.evidence.length > 0 && known.evidence.every(key => profile.evidence[key]))).map(({ scenario, id }) => ({ scenario, id }));
  return { passed: missingEvidence.length === 0 && unclassifiedFailures.length === 0 && incompleteChecks.length === 0 && requiredInventoryErrors.length === 0,
    diagnosticFailures: failures.length - unclassifiedFailures.length, unclassifiedFailures, missingEvidence, incompleteChecks, requiredInventoryErrors };
}

async function requiredChecks(directory, requirements) {
  const names = [...(requirements.match(/^server:\n([\s\S]*?)^client:/m)?.[1] ?? '').matchAll(/^  - ([\w-]+)$/gm)].map(match => match[1]);
  const entries = await readdir(directory), checks = [];
  for (const scenario of names) {
    const matches = entries.filter(entry => entry.startsWith(`server-${scenario}-20`));
    if (matches.length !== 1) throw new Error('Missing or repeated required scenario');
    const rows = JSON.parse(await readFile(join(directory, matches[0], 'checks.json'), 'utf8'));
    checks.push(...rows.map(check => ({ ...check, scenario })));
  }
  return checks;
}

export async function summarizeConformance(directory, requirements) {
  // Read the simple, frozen referee manifest, not a mutable scenario listing.
  const required = [...(requirements.match(/^server:\n([\s\S]*?)^client:/m)?.[1] ?? '').matchAll(/^  - ([\w-]+)$/gm)].map(match => match[1]);
  if (!required.length) throw new Error('Missing frozen server requirements');
  const optional = [...requirements.matchAll(/^  - scenario: ([\w-]+)\n    leg: server\n    reason: ([\w-]+)/gm)].map(match => ({ name: match[1], reason: match[2] }));
  const entries = await readdir(directory).catch(() => []);
  async function group(names, isRequired = false) {
    const report = { scenarios: names.length, passed: 0, failed: 0, warnings: 0, skipped: 0, missing: 0, failedScenarios: [] };
    for (const name of names) {
      const matches = entries.filter(entry => entry.startsWith(`server-${name}-20`));
      let checks;
      try {
        if (matches.length !== 1) throw new Error('Missing or repeated scenario');
        checks = JSON.parse(await readFile(join(directory, matches[0], 'checks.json'), 'utf8'));
        if (!Array.isArray(checks) || (isRequired && !checks.length) || checks.some(check => !['SUCCESS', 'FAILURE', 'WARNING', 'INFO', 'SKIPPED'].includes(check.status))) throw new Error('Invalid checks');
      } catch { report.missing++; report.failedScenarios.push(name); continue; }
      report.passed += checks.filter(check => check.status === 'SUCCESS').length;
      report.failed += checks.filter(check => check.status === 'FAILURE').length;
      report.warnings += checks.filter(check => check.status === 'WARNING').length;
      report.skipped += checks.filter(check => check.status === 'SKIPPED').length;
      if (checks.some(check => check.status === 'FAILURE')) report.failedScenarios.push(name);
    }
    return report;
  }
  const requiredReport = await group(required, true);
  const notScored = {
    extension: await group(optional.filter(item => item.reason === 'extension').map(item => item.name)),
    pending: await group(optional.filter(item => item.reason === 'pending').map(item => item.name)),
    'added-after-release': await group(optional.filter(item => item.reason === 'added-after-release').map(item => item.name)),
  };
  return { revision, refereeVersion, required: requiredReport, notScored,
    passed: requiredReport.failed === 0 && requiredReport.missing === 0 && requiredReport.skipped === 0 };
}

async function unusedPort() {
  const reservation = createServer();
  await new Promise((ok, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', ok); });
  const port = reservation.address().port;
  await new Promise((ok, fail) => reservation.close(error => error ? fail(error) : ok()));
  return port;
}

export function start(args, directory, log, environment) {
  if (process.platform === 'win32') throw new Error('Local conformance requires POSIX process-group isolation');
  const child = spawn(process.execPath, args, {
    cwd: directory, env: environment, stdio: ['ignore', log.fd, log.fd], detached: true,
  });
  const done = new Promise(resolveDone => {
    child.once('error', () => resolveDone(1));
    child.once('exit', code => resolveDone(code ?? 1));
  });
  return { child, done };
}

export async function stop(processHandle) {
  if (!processHandle) return;
  // Share one cleanup promise across signals/finally, and never signal a group
  // again after it disappeared (its numeric ID could eventually be reused).
  return processHandle.stopping ??= (async () => {
    const { child, done } = processHandle;
    if (!child.pid) { await done; return; }
    const signalGroup = signal => {
      try { process.kill(-child.pid, signal); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const waitForGroup = async () => {
      const deadline = Date.now() + 5000;
      while (signalGroup(0)) {
        if (Date.now() >= deadline) return false;
        await delay(25);
      }
      return true;
    };
    if (signalGroup('SIGTERM') && !await waitForGroup()) {
      signalGroup('SIGKILL');
      if (!await waitForGroup()) throw new Error('Owned conformance process group did not terminate');
    }
    await done;
  })();
}

/** Local-only protocol verification. No inherited provider or Cloudflare credentials. */
export async function runConformance(root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const referee = join(root, 'node_modules/@modelcontextprotocol/conformance');
  if (JSON.parse(await readFile(join(referee, 'package.json'), 'utf8')).version !== refereeVersion) {
    throw new Error('Install the pinned conformance dependency with bun install --frozen-lockfile');
  }
  const requirements = await readFile(join(referee, `requirements/${revision}.yaml`), 'utf8');
  const profile = JSON.parse(await readFile(join(root, 'scripts/mcp-conformance-profile.json'), 'utf8'));
  if (profile.revision !== revision || profile.refereeVersion !== refereeVersion
    || profile.profile !== 'transit-mcp-2026-07-28-v2'
    || profile.requirementsSha256 !== createHash('sha256').update(requirements).digest('hex')
    || profile.refereeSha256 !== createHash('sha256').update(await readFile(join(referee, 'dist/index.js'))).digest('hex')
    || JSON.stringify(Object.keys(profile.requiredChecks).sort()) !== JSON.stringify([...(requirements.match(/^server:\n([\s\S]*?)^client:/m)?.[1] ?? '').matchAll(/^  - ([\w-]+)$/gm)].map(match => match[1]).sort())) throw new Error('Frozen profile, inventory or referee mismatch');
  const directory = await mkdtemp(join(tmpdir(), 'transit-mcp-conformance-'));
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  // A fresh configuration directory prevents Wrangler from discovering the
  // checkout's .dev.vars or .env files. No cron, remote bindings or routes.
  const config = {
    name: 'transit-mcp-local-conformance', main: join(root, 'src/index.ts'),
    compatibility_date: '2026-04-07', compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
    assets: { directory: join(root, 'public'), binding: 'ASSETS' },
    vars: { MCP_PUBLIC_ORIGIN: origin, MCP_ALLOWED_HOSTNAMES: '127.0.0.1,localhost',
      MCP_ALLOWED_ORIGIN_HOSTNAMES: '127.0.0.1,localhost', ENVIRONMENT: 'development', SFBAY_MODE: 'off',
      TRANSIT_COVERAGE_MODES: '{"dc":"off","nyc":"off","sfbay":"off"}' },
    durable_objects: { bindings: [{ name: 'REGION_FEED_HUB', class_name: 'RegionFeedHub' }] },
    migrations: [{ tag: 'local', new_sqlite_classes: ['RegionFeedHub'] }],
    r2_buckets: [{ binding: 'TRANSIT_ARTIFACTS', bucket_name: 'local-conformance-artifacts' }],
    ratelimits: [{ name: 'MCP_RATE_LIMITER', namespace_id: '1', simple: { limit: 100000, period: 60 } }],
  };
  await writeFile(join(directory, 'wrangler.json'), JSON.stringify(config), { mode: 0o600 });
  // Public test material, never a production credential; no upstream API keys.
  await writeFile(join(directory, '.dev.vars'), 'MCP_REQUEST_STATE_KEY=local-conformance-only-never-use-in-production\nWMATA_API_KEY=local-placeholder-not-a-provider-credential\n', { mode: 0o600 });
  const environment = { PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory,
    WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
    MCP_CONFORMANCE_WRANGLER_CONFIG: join(directory, 'wrangler.json'),
    WRANGLER_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', NO_COLOR: '1' };
  const workerLog = await open(join(directory, 'worker.log'), 'w', 0o600);
  const suiteLog = await open(join(directory, 'conformance.log'), 'w', 0o600);
  const requirementsLog = await open(join(directory, 'requirements.txt'), 'w', 0o600);
  const localLog = await open(join(directory, 'product-tests.log'), 'w', 0o600);
  let worker, suite, interrupted = false;
  const owned = [];
  const launch = (...args) => {
    const handle = start(...args); owned.push(handle);
    // Reap descendants immediately when any leader exits, before its numeric
    // group ID can be reused. Finally still awaits each cached cleanup result.
    void handle.done.then(() => stop(handle)).catch(() => {});
    return handle;
  };
  const interrupt = () => { interrupted = true; for (const handle of owned) void stop(handle).catch(() => {}); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    worker = launch([join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--config', join(directory, 'wrangler.json'),
      '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', join(directory, 'state')], directory, workerLog, environment);
    let ready = false;
    for (let attempt = 0; attempt < 120 && !interrupted; attempt++) {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) break;
      try {
        const response = await fetch(`${origin}/info`, { redirect: 'error', signal: AbortSignal.timeout(500) });
        const info = await response.json();
        if (response.ok && info.name === 'Transit MCP' && info.protocolVersion === revision) { ready = true; break; }
      } catch { /* Worker is still starting; no raw errors or credentials. */ }
      await delay(250);
    }
    if (!ready || interrupted) throw new Error('Local Worker did not become ready');
    const cli = join(referee, 'dist/index.js');
    suite = launch([cli, 'list', '--requirements', revision], directory, requirementsLog, environment);
    if (await suite.done !== 0 || interrupted) throw new Error('Frozen requirement listing failed');
    suite = launch([cli, 'server', '--url', `${origin}/mcp`, '--requirements', revision, '--output-dir', join(directory, 'results')], directory, suiteLog, environment);
    // The pinned referee scores the 37 frozen required server scenarios and
    // reports its not_scored extensions/pending scenarios separately. No waiver.
    const timer = setTimeout(interrupt, 10 * 60 * 1000);
    let officialExitCode;
    try { officialExitCode = await suite.done; } finally { clearTimeout(timer); }
    const summary = await summarizeConformance(join(directory, 'results'), requirements);
    await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    const files = [...new Set(Object.values(profile.evidence).map(item => item.file))];
    let localPassed = true;
    const evidence = [];
    for (const [kind, config] of [['unit', 'vitest.config.ts'], ['workers', 'vitest.workers.config.ts']]) {
      if (interrupted) throw new Error('Interrupted');
      const selected = files.filter(file => file.startsWith('tests/workers/') === (kind === 'workers'));
      if (!selected.length) continue;
      const reportPath = join(directory, `product-${kind}.json`);
      suite = launch([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(root, config), ...selected,
        '--reporter=json', '--outputFile', reportPath], root, localLog, environment);
      const localTimer = setTimeout(interrupt, 180000);
      try { if (await suite.done !== 0) localPassed = false; } finally { clearTimeout(localTimer); }
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      if (report.success !== true || !report.numTotalTests) localPassed = false;
      for (const result of report.testResults) for (const assertion of result.assertionResults) {
        evidence.push({ file: relative(root, result.name).replaceAll('\\', '/'), title: assertion.title, status: assertion.status });
      }
    }
    const product = scoreProductConformance(profile, await requiredChecks(join(directory, 'results'), requirements), evidence);
    product.passed &&= localPassed && !interrupted && summary.required.missing === 0 && [0, 1].includes(officialExitCode);
    const exitCode = product.passed ? 0 : 1;
    await writeFile(join(directory, 'product-profile.json'), JSON.stringify({ profile: profile.profile, ...product }, null, 2));
    await writeFile(join(directory, 'run.json'), JSON.stringify({ revision, refereeVersion, exitCode, officialExitCode,
      evidence: 'local Worker; no authoritative transit data; not production acceptance',
      scoring: 'Product profile only: exact diagnostic fixture gaps require mapped real tests. Full official score remains unchanged. Unknown failures block. Optional extensions/pending are separate.' }, null, 2));
    return { directory, exitCode, officialExitCode, summary, product };
  } catch {
    throw new Error(`Local conformance failed; inspect private artifacts in ${directory}`);
  } finally {
    try { await Promise.all(owned.map(stop)); }
    finally {
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      await Promise.all([workerLog.close(), suiteLog.close(), requirementsLog.close(), localLog.close()]);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConformance().then(({ directory, exitCode, officialExitCode, summary, product }) => {
    console.log(`Frozen MCP ${revision} product profile exit: ${exitCode}; full official suite exit: ${officialExitCode}. Evidence: ${directory}`);
    console.log(JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ productProfile: product }, null, 2));
    process.exitCode = exitCode;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
