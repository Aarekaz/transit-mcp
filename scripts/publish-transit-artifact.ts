import { join } from 'node:path';
import { canonicalJson, sha256 } from '../src/transit/gtfs/static/shards';
import { staticVersion } from '../src/transit/gtfs/realtime/snapshot-store';
import type { ArtifactManifestV2 } from '../src/transit/gtfs/static/schema';

/** Publishes one built v2 artifact with StaticArtifactStore.publish semantics: verify
 * every object, upload immutable objects, then the manifest, and move the pointer last
 * (keeping the prior version as `previous`). Credentials stay with Wrangler.
 *
 * bun scripts/publish-transit-artifact.ts <built-directory> <bucket> --local|--remote [--persist-to <dir>] [--dry-run] */
const [directory, bucket, target, ...rest] = process.argv.slice(2);
if (!directory || !bucket || (target !== '--local' && target !== '--remote')) throw new Error('Usage: <built-directory> <bucket> --local|--remote [--persist-to <dir>] [--dry-run]');
const dryRun = rest.includes('--dry-run');
const persist = rest.includes('--persist-to') ? ['--persist-to', rest[rest.indexOf('--persist-to') + 1]!] : [];

const manifestBytes = new Uint8Array(await Bun.file(join(directory, 'manifest.json')).arrayBuffer());
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ArtifactManifestV2;
const version = await staticVersion(manifest);
if (await sha256(manifestBytes) !== version.artifactVersion || new TextDecoder().decode(manifestBytes) !== `${canonicalJson(manifest)}\n`) throw new Error('Manifest is not canonical');
const prefix = `artifacts/${manifest.coverageId}/v2/`;
const objects = [...manifest.discoveries, ...manifest.shards];
for (const object of objects) {
  if (!object.key.startsWith(prefix)) throw new Error(`Object outside coverage namespace: ${object.key}`);
  const bytes = new Uint8Array(await Bun.file(join(directory, object.key)).arrayBuffer());
  if (bytes.length !== object.byteLength || await sha256(bytes) !== object.sha256) throw new Error(`Integrity failure: ${object.key}`);
}

async function wrangler(args: string[]): Promise<{ code: number; stdout: string }> {
  const process = Bun.spawn(['node', 'node_modules/wrangler/bin/wrangler.js', 'r2', 'object', ...args, target!, ...persist], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  return { code, stdout };
}
async function put(key: string, file: string, contentType: string) {
  console.info(JSON.stringify({ action: dryRun ? 'would_put' : 'put', key }));
  if (dryRun) return;
  const result = await wrangler(['put', `${bucket}/${key}`, `--file=${file}`, `--content-type=${contentType}`]);
  if (result.code !== 0) throw new Error(`Upload failed: ${key}`);
}

for (const object of objects) await put(object.key, join(directory, object.key), object.key.endsWith('.json') ? 'application/json' : 'application/octet-stream');
const manifestKey = `${prefix}manifests/${version.artifactVersion}.json`;
await put(manifestKey, join(directory, 'manifest.json'), 'application/json');

const pointerKey = `${prefix}current.json`;
const pointerFile = join(directory, '.current.json');
const existing = await wrangler(['get', `${bucket}/${pointerKey}`, `--file=${pointerFile}`]);
const prior = existing.code === 0 ? await Bun.file(pointerFile).json() as { current?: string; previous?: string } : undefined;
const pointer = { current: version.artifactVersion, previous: prior?.current === version.artifactVersion ? prior.previous : prior?.current };
await Bun.write(pointerFile, `${canonicalJson(pointer)}\n`);
await put(pointerKey, pointerFile, 'application/json');
console.info(JSON.stringify({ coverage: manifest.coverageId, artifactVersion: version.artifactVersion, previous: pointer.previous ?? null, objects: objects.length, dryRun }));
