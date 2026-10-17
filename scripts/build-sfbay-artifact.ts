import { compileGtfsStatic, type GtfsStaticFiles } from '../src/transit/gtfs/static/compiler';

const REQUIRED_FILES = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'] as const;
const outputPath = process.argv[2] ?? '.artifacts/sfbay-current.json';
const inputDirectory = process.env.SFBAY_GTFS_DIRECTORY;

async function readFilesFromDirectory(directory: string): Promise<GtfsStaticFiles> {
  return Object.fromEntries(await Promise.all(REQUIRED_FILES.map(async name => [
    name,
    await Bun.file(`${directory}/${name}`).text(),
  ]))) as GtfsStaticFiles;
}

async function readFilesFrom511(apiKey: string): Promise<{ files: GtfsStaticFiles; sourceVersion: string }> {
  const url = new URL('https://api.511.org/transit/datafeeds');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('operator_id', 'RG');
  url.searchParams.set('status', 'active');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`511 static feed returned HTTP ${response.status}`);
  const zip = new Uint8Array(await response.arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', zip);
  const sourceVersion = `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const temporaryZip = `${process.env.TMPDIR ?? '/tmp'}/sfbay-gtfs-${crypto.randomUUID()}.zip`;
  await Bun.write(temporaryZip, zip);
  try {
    const entries = await Promise.all(REQUIRED_FILES.map(async name => {
      const process = Bun.spawn(['unzip', '-p', temporaryZip, name], { stdout: 'pipe', stderr: 'pipe' });
      const text = await new Response(process.stdout).text();
      const exitCode = await process.exited;
      if (exitCode !== 0) throw new Error(`Regional GTFS archive is missing ${name}`);
      return [name, text] as const;
    }));
    return { files: Object.fromEntries(entries) as GtfsStaticFiles, sourceVersion };
  } finally {
    await Bun.file(temporaryZip).delete();
  }
}

const source = inputDirectory
  ? { files: await readFilesFromDirectory(inputDirectory), sourceVersion: `directory:${inputDirectory}` }
  : await readFilesFrom511(process.env.SF511_API_KEY ?? (() => { throw new Error('SF511_API_KEY is required'); })());
const artifact = compileGtfsStatic(source.files, {
  sourceVersion: source.sourceVersion,
  generatedAt: new Date().toISOString(),
});
await Bun.write(outputPath, `${JSON.stringify(artifact)}\n`);
console.info(JSON.stringify({ outputPath, stops: artifact.stops.length, routes: artifact.routes.length, sourceVersion: artifact.sourceVersion }));
