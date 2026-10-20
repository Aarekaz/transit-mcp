import { join } from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import { compileSchedule, unusedInputs } from '../src/transit/gtfs/static/compiler';
import { readZipDirectory } from '../src/transit/gtfs/static/zip';
import { partitionSchedule } from '../src/transit/gtfs/static/partition';
import { validateMobilityDataReport, validateMobilityDataSystemErrors } from '../src/transit/gtfs/static/artifact';
import { canonicalJson, sha256 } from '../src/transit/gtfs/static/shards';
import type { GtfsScheduleFiles, IgnorableField } from '../src/transit/gtfs/static/schema';
import { getCoverage } from '../src/transit/core/coverage';

/** Offline: compiles one already-downloaded, already-validated official GTFS archive
 * into immutable, content-addressed v2 objects. It never fetches, uploads, or reads
 * credentials. Usage: bun scripts/build-transit-artifact.ts <output-directory> */
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const coverage = getCoverage(required('TRANSIT_COVERAGE'));
if (!coverage) throw new Error('Unknown TRANSIT_COVERAGE');
const feedId = required('TRANSIT_FEED');
const archivePath = required('TRANSIT_SOURCE_ARCHIVE');
const inputDirectory = required('TRANSIT_GTFS_DIRECTORY');
// Every invocation names its report explicitly; a stale report is never discovered.
const reportPath = required('TRANSIT_VALIDATOR_REPORT');
const systemErrorsPath = required('TRANSIT_VALIDATOR_SYSTEM_ERRORS');
const window = { startDate: required('TRANSIT_WINDOW_START'), endDate: required('TRANSIT_WINDOW_END') };
const bandSeconds = Number(process.env.TRANSIT_BAND_HOURS ?? 3) * 3600;
// Reviewed per coverage: publisher fields left unused, and agency-split bands for large regions.
const ignoredFields = (process.env.TRANSIT_IGNORED_FIELDS ? process.env.TRANSIT_IGNORED_FIELDS.split(',') : []) as IgnorableField[];
if (ignoredFields.some(field => field !== 'trips.txt:block_id')) throw new Error('Unsupported ignored field');
const agencyGroups = process.env.TRANSIT_AGENCY_GROUPS ? Number(process.env.TRANSIT_AGENCY_GROUPS) : undefined;
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('Output directory is required');

const archiveBytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer()), archiveSha256 = await sha256(archiveBytes);
const archiveFiles = [...readZipDirectory(archiveBytes).keys()];
if (process.env.TRANSIT_SOURCE_ARCHIVE_SHA256 && process.env.TRANSIT_SOURCE_ARCHIVE_SHA256 !== archiveSha256) throw new Error('Archive hash does not match the retrieved archive');
const mandatory = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'] as const;
const optional = ['calendar.txt', 'calendar_dates.txt', 'feed_info.txt', 'frequencies.txt', 'transfers.txt', 'pathways.txt'] as const;
const entries = await Promise.all([...mandatory, ...optional].map(async name => {
  const file = Bun.file(join(inputDirectory, name));
  if (!(await file.exists()) && !mandatory.includes(name as typeof mandatory[number])) return null;
  return [name, await file.text()] as const;
}));
const files = Object.fromEntries(entries.filter(entry => entry !== null)) as GtfsScheduleFiles;
const reportJson = await Bun.file(reportPath).text();
const allowlist = await Bun.file(join(import.meta.dir, '..', 'data', `${coverage.id}-validator-allowlist.json`)).json();
// An accepted ERROR must concern only inputs this exact build never reads.
const validator = await validateMobilityDataReport(reportJson, allowlist, coverage.id, new Date().toISOString().slice(0, 10), unusedInputs(archiveFiles, ignoredFields));
const systemErrors = await validateMobilityDataSystemErrors(await Bun.file(systemErrorsPath).text());
const compiled = await compileSchedule({ coverage, feedId, files, window,
  source: { url: required('TRANSIT_SOURCE_URL'), retrievedAt: required('TRANSIT_SOURCE_RETRIEVED_AT') }, ...(ignoredFields.length ? { ignoredFields } : {}) });
// Binding the archive hash before partitioning stamps it into every shard's source.
compiled.shard.source.archiveSha256 = archiveSha256;
compiled.manifest.sources[0]!.archiveSha256 = archiveSha256;
// A derived archive (publisher files removed, never edited) records what it came from.
if (process.env.TRANSIT_DERIVED_FROM_SHA256) {
  const derivedFrom = { archiveSha256: process.env.TRANSIT_DERIVED_FROM_SHA256, excludedFiles: required('TRANSIT_DERIVED_EXCLUDED_FILES').split(','),
    reason: required('TRANSIT_DERIVED_REASON') };
  if (derivedFrom.excludedFiles.some(name => name in files)) throw new Error('An excluded file is still present');
  compiled.shard.source.derivedFrom = derivedFrom;
  compiled.manifest.sources[0]!.derivedFrom = derivedFrom;
}
if (ignoredFields.length) {
  // The validated archive is the publisher's own; the build records what it left unused.
  const derivedFrom = { archiveSha256: compiled.shard.source.derivedFrom?.archiveSha256 ?? archiveSha256, excludedFiles: compiled.shard.source.derivedFrom?.excludedFiles ?? [],
    reason: required('TRANSIT_DERIVED_REASON'), ignoredFields: [...ignoredFields] };
  compiled.shard.source.derivedFrom = derivedFrom;
  compiled.manifest.sources[0]!.derivedFrom = derivedFrom;
}
for (const info of compiled.shard.source.feedInfo) {
  if (info.feed_start_date && window.startDate < info.feed_start_date || info.feed_end_date && window.endDate > info.feed_end_date) {
    throw new Error('Service window extends beyond the publisher feed dates');
  }
}
if (Date.parse(validator.validatedAt) < Date.parse(compiled.manifest.sources[0]!.retrievedAt)) throw new Error('Validator report predates source retrieval');
const report = JSON.parse(reportJson);
if (report.sourceSha256 !== undefined && report.sourceSha256 !== compiled.manifest.sources[0]!.sha256) throw new Error('Validator report input does not match this source');
const partitioned = await partitionSchedule(compiled, bandSeconds, agencyGroups ? { agencyGroups } : {});
partitioned.manifest.validator = { ...validator, ...systemErrors };
const manifestBytes = new TextEncoder().encode(`${canonicalJson(partitioned.manifest)}\n`);
const artifactVersion = await sha256(manifestBytes);
const manifestKey = `artifacts/${coverage.id}/v2/manifests/${artifactVersion}.json`;
// All validation completes before writing anything. Objects are immutable; the local
// manifest pointer is written last, atomically.
for (const { key, bytes } of [...partitioned.objects, { key: manifestKey, bytes: manifestBytes }]) await Bun.write(join(outputDirectory, key), bytes);
await mkdir(outputDirectory, { recursive: true });
const pending = join(outputDirectory, `.manifest-${crypto.randomUUID()}.tmp`);
await Bun.write(pending, manifestBytes);
await rename(pending, join(outputDirectory, 'manifest.json'));
const largest = Math.max(...partitioned.manifest.shards.map(shard => shard.byteLength));
console.info(JSON.stringify({ outputDirectory, coverage: coverage.id, artifactVersion, manifestKey, objects: partitioned.objects.length + 1,
  shards: partitioned.manifest.shards.length, largestShardBytes: largest, stops: compiled.discovery.stops.length, routes: compiled.discovery.routes.length,
  trips: compiled.shard.trips.length, sourceSha256: compiled.shard.source.sha256, archiveSha256, validator: partitioned.manifest.validator }));
