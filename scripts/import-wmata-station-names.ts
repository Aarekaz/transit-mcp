/**
 * WMATA's GTFS names stations shortly ("Gallery Place"); riders, signs and WMATA's own API use
 * the full names ("Gallery Pl-Chinatown"). This writes those official names, and the place
 * names inside them ("Chinatown", "Convention Center"), as aliases of the GTFS stations.
 *
 *   npx tsx scripts/import-wmata-station-names.ts <dc-discovery.json> [wmata-stations.json]
 *
 * The discovery index is the published DC rail one (from R2). Stations come from WMATA's
 * Rail.svc jStations (WMATA_API_KEY), or a saved get_all_stations result from this server.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const OUTPUT = 'data/coverage/dc/station-names.json';
const SOURCE = 'https://api.wmata.com/Rail.svc/json/jStations';
/** Pieces of a hyphenated official name that are not places on their own. */
const NOT_PLACES = new Set(['african', 'amer civil war memorial']);

const fold = (value: string) => value.toLowerCase().replace(/['’]/g, '').replace(/[-–—/.,()+&]/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').map(word => ({ street: 'st', avenue: 'av', ave: 'av', road: 'rd', boulevard: 'blvd', square: 'sq', place: 'pl' } as Record<string, string>)[word] ?? word).join(' ');

async function wmataStations(saved?: string): Promise<{ code: string; name: string }[]> {
  if (saved) return (JSON.parse(readFileSync(saved, 'utf8')).stations as { id: string; name: string }[]).map(station => ({ code: station.id, name: station.name }));
  const key = process.env.WMATA_API_KEY;
  if (!key) throw new Error('Set WMATA_API_KEY or pass a saved get_all_stations result');
  const response = await fetch(SOURCE, { headers: { api_key: key } });
  if (!response.ok) throw new Error(`WMATA ${response.status}`);
  return ((await response.json()) as { Stations: { Code: string; Name: string }[] }).Stations.map(station => ({ code: station.Code, name: station.Name }));
}

const [discoveryPath, savedStations] = process.argv.slice(2);
if (!discoveryPath) throw new Error('Pass the DC rail discovery index');
const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { stops: { providerId: string; name: string }[] };
// GTFS station IDs carry WMATA codes: STN_A01_C01 is Metro Center (A01 and C01).
const gtfsByCode = new Map<string, string>();
for (const stop of discovery.stops.filter(stop => stop.providerId.startsWith('STN_'))) for (const code of stop.providerId.match(/[A-Z]\d\d/g) ?? []) gtfsByCode.set(code, stop.name);

const official = new Map<string, { names: Set<string>; codes: string[] }>();
for (const station of await wmataStations(savedStations)) {
  const gtfs = gtfsByCode.get(station.code);
  if (!gtfs) continue;
  const entry = official.get(gtfs) ?? { names: new Set(), codes: [] };
  entry.names.add(station.name); entry.codes.push(station.code); official.set(gtfs, entry);
}

// A place name inside an official name: its "/" segments and "-" pieces.
const parts = (name: string) => [name, ...name.split('/').flatMap(segment => [segment, ...segment.split('-')])].map(part => part.trim()).filter(Boolean);
const taken = new Set([...official.keys()].map(fold));
const owners = new Map<string, Set<string>>();
for (const [gtfs, { names }] of official) for (const name of names) for (const part of parts(name)) owners.set(fold(part), (owners.get(fold(part)) ?? new Set()).add(gtfs));

const places = [...official].flatMap(([gtfs, { names, codes }]) => {
  const aliases = [...new Set([...names].flatMap(parts))].filter(part => {
    const folded = fold(part);
    // Name folding already finds these; a part two stations share (GMU) or another
    // station's own name would pick a station silently; a fragment is not a place.
    return folded.length >= 4 && folded !== fold(gtfs) && !NOT_PLACES.has(folded) && owners.get(folded)!.size === 1 && !(taken.has(folded) && folded !== fold(gtfs));
  });
  return aliases.length ? [{ name: gtfs, aliases, stopNames: [gtfs], sources: [SOURCE],
    basis: `WMATA station ${[...new Set(codes)].sort().join('/')} is published as "${[...names].join('" / "')}"; the GTFS feed names it "${gtfs}".` }] : [];
}).sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(OUTPUT, `${JSON.stringify({ coverageId: 'dc', scope: 'official_station_names', generatedBy: 'scripts/import-wmata-station-names.ts', source: SOURCE, places }, null, 2)}\n`);
console.log(`${places.length} stations, ${places.reduce((sum, place) => sum + place.aliases.length, 0)} aliases → ${OUTPUT}`);
