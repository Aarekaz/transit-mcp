import { join } from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import { compileSchedule } from '../src/transit/gtfs/static/compiler';
import { validateMobilityDataReport, validateMobilityDataSystemErrors } from '../src/transit/gtfs/static/artifact';
import { canonicalJson, sha256 } from '../src/transit/gtfs/static/shards';
import type { GtfsScheduleFiles } from '../src/transit/gtfs/static/schema';
import { SFBAY_COVERAGE } from '../src/regions/sfbay';
import allowlist from '../data/sfbay-validator-allowlist.json';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const inputDirectory = required('SFBAY_GTFS_DIRECTORY');
// The canonical report has no input content hash. Require an explicit report for
// every invocation and record its own hash/version; never discover a stale report.
const reportPath = required('SFBAY_VALIDATOR_REPORT');
const systemErrorsPath = required('SFBAY_VALIDATOR_SYSTEM_ERRORS');
const outputDirectory = process.argv[2] ?? '.artifacts/sfbay-v2';
const mandatory = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'] as const;
const optional = ['calendar.txt', 'calendar_dates.txt', 'feed_info.txt', 'frequencies.txt', 'transfers.txt', 'pathways.txt'] as const;
const entries = await Promise.all([...mandatory, ...optional].map(async name => {
  const file = Bun.file(join(inputDirectory, name));
  if (!(await file.exists()) && !mandatory.includes(name as typeof mandatory[number])) return null;
  return [name, await file.text()] as const;
}));
const files = Object.fromEntries(entries.filter(entry => entry !== null)) as GtfsScheduleFiles;
const reportJson = await Bun.file(reportPath).text();
const validator = await validateMobilityDataReport(reportJson, allowlist, SFBAY_COVERAGE.id, new Date().toISOString().slice(0, 10));
const systemErrors = await validateMobilityDataSystemErrors(await Bun.file(systemErrorsPath).text());
const result = await compileSchedule({ coverage: SFBAY_COVERAGE, feedId: 'sf511', files,
  window: { startDate: required('SFBAY_WINDOW_START'), endDate: required('SFBAY_WINDOW_END') },
  source: { url: 'https://api.511.org/transit/datafeeds', retrievedAt: required('SFBAY_SOURCE_RETRIEVED_AT') },
});
result.manifest.validator = { ...validator, ...systemErrors };
// Optional provenance bindings supplied by a validation pipeline fail closed.
const report = JSON.parse(reportJson);
if ((report.sourceSha256 !== undefined && report.sourceSha256 !== result.manifest.sources[0]!.sha256) ||
    (report.feedId !== undefined && report.feedId !== 'sf511')) throw new Error('Validator report input does not match this source');
const manifestBytes = new TextEncoder().encode(`${canonicalJson(result.manifest)}\n`);
const manifestKey = `artifacts/sfbay/v2/manifests/${await sha256(manifestBytes)}.json`;
// All validation completes before writing anything. Objects are immutable and
// the local manifest pointer changes atomically only after every object exists.
for (const [key, bytes] of [
  [result.manifest.discovery.key, result.discoveryBytes],
  [result.manifest.shards[0]!.key, result.shardBytes],
  [manifestKey, manifestBytes],
] as const) await Bun.write(join(outputDirectory, key), bytes);
await mkdir(outputDirectory, { recursive: true });
const pendingManifest = join(outputDirectory, `.manifest-${crypto.randomUUID()}.tmp`);
await Bun.write(pendingManifest, manifestBytes);
await rename(pendingManifest, join(outputDirectory, 'manifest.json'));
console.info(JSON.stringify({ outputDirectory, manifestKey, stops: result.discovery.stops.length,
  routes: result.discovery.routes.length, trips: result.shard.trips.length, sourceSha256: result.shard.source.sha256 }));
