#!/usr/bin/env bun

/**
 * Parse NYC GTFS static data to generate enhanced station and route data for MTA client
 *
 * Generates:
 * - nyc-stations.ts: Stations with transfers and child platforms
 * - nyc-routes.ts: Routes with descriptions
 *
 * Usage: bun run scripts/parse-nyc-gtfs.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface GTFSStop {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
  location_type: string;
  parent_station: string;
}

interface GTFSRoute {
  route_id: string;
  route_short_name: string;
  route_long_name: string;
  route_desc: string;
}

interface GTFSTransfer {
  from_stop_id: string;
  to_stop_id: string;
  transfer_type: string;
  min_transfer_time: string;
}

interface StopTime {
  stop_id: string;
  trip_id: string;
}

interface Trip {
  trip_id: string;
  route_id: string;
}

interface StationTransfer {
  toStationId: string;
  toStationName: string;
  transferTime: number;
  transferType: 'platform' | 'nearby';
}

interface Station {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  lines: string[];
  childPlatforms?: string[];
  transfers?: StationTransfer[];
}

interface Route {
  routeId: string;
  shortName: string;
  longName: string;
  description: string;
}

/**
 * Robust CSV parser that handles quoted fields with commas
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  // Strip surrounding quotes from fields
  return result.map(field => field.replace(/^"|"$/g, ''));
}

/**
 * Parse CSV file with robust handling of quoted fields
 */
function parseCSV<T>(filePath: string): T[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = parseCSVLine(lines[0]!);

  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj: any = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] || '';
    });
    return obj as T;
  });
}

console.log('📊 Parsing NYC GTFS data...\n');

// Try data/nyc first, fall back to docs/gtfs_subway
const dataDir = join(process.cwd(), 'data', 'nyc');
const docsDir = join(process.cwd(), 'docs', 'gtfs_subway');
let gtfsDir = dataDir;

try {
  readFileSync(join(dataDir, 'stops.txt'));
  console.log(`📁 Using GTFS data from: ${dataDir}\n`);
} catch {
  console.log(`📁 Using GTFS data from: ${docsDir}\n`);
  gtfsDir = docsDir;
}

// 1. Load parent stations (location_type = 1) and all stops
console.log('1️⃣  Loading stations from stops.txt...');
const allStops = parseCSV<GTFSStop>(join(gtfsDir, 'stops.txt'));
const parentStations = allStops.filter(stop => stop.location_type === '1');
const stationNameMap = new Map(allStops.map(s => [s.stop_id, s.stop_name]));
console.log(`   Found ${parentStations.length} parent stations`);

// 2. Load routes with full metadata
console.log('\n2️⃣  Loading routes...');
const gtfsRoutes = parseCSV<GTFSRoute>(join(gtfsDir, 'routes.txt'));
const routeMap = new Map(gtfsRoutes.map(r => [r.route_id, r.route_short_name]));
console.log(`   Found ${gtfsRoutes.length} routes`);

// 3. Parse route data for nyc-routes.ts
console.log('\n3️⃣  Parsing route descriptions...');
const routeData: Route[] = gtfsRoutes.map(r => ({
  routeId: r.route_id,
  shortName: r.route_short_name || r.route_id,
  longName: r.route_long_name || r.route_short_name || r.route_id,
  description: r.route_desc || ''
}));
console.log(`   Parsed ${routeData.length} routes with descriptions`);

// 4. Load transfers
console.log('\n4️⃣  Loading transfers...');
const gtfsTransfers = parseCSV<GTFSTransfer>(join(gtfsDir, 'transfers.txt'));
console.log(`   Found ${gtfsTransfers.length} transfer entries`);

// 5. Build transfer graph (exclude self-transfers with time=0)
console.log('\n5️⃣  Building transfer graph...');
const transferMap = new Map<string, StationTransfer[]>();

for (const transfer of gtfsTransfers) {
  const fromId = transfer.from_stop_id;
  const toId = transfer.to_stop_id;
  const time = parseInt(transfer.min_transfer_time) || 0;

  // Skip self-transfers with time=0 (platform switches)
  if (fromId === toId && time === 0) {
    continue;
  }

  // Get parent station IDs (strip N/S suffixes if present)
  const fromParent = allStops.find(s => s.stop_id === fromId)?.parent_station || fromId;
  const toParent = allStops.find(s => s.stop_id === toId)?.parent_station || toId;

  // Skip if not a cross-station transfer
  if (fromParent === toParent) {
    continue;
  }

  const toName = stationNameMap.get(toId) || 'Unknown Station';

  if (!transferMap.has(fromParent)) {
    transferMap.set(fromParent, []);
  }

  transferMap.get(fromParent)!.push({
    toStationId: toParent,
    toStationName: toName,
    transferTime: time,
    transferType: 'nearby'
  });

  // Add reverse transfer if not already defined
  const hasReverse = gtfsTransfers.some(t => t.from_stop_id === toId && t.to_stop_id === fromId);
  if (!hasReverse) {
    const fromName = stationNameMap.get(fromId) || 'Unknown Station';
    if (!transferMap.has(toParent)) {
      transferMap.set(toParent, []);
    }
    transferMap.get(toParent)!.push({
      toStationId: fromParent,
      toStationName: fromName,
      transferTime: time,
      transferType: 'nearby'
    });
  }
}

console.log(`   Built transfer graph with ${transferMap.size} stations having transfers`);

// 6. Build child platforms mapping
console.log('\n6️⃣  Building parent/child platform relationships...');
const childPlatformsMap = new Map<string, string[]>();

for (const stop of allStops) {
  if (stop.parent_station && stop.parent_station !== '') {
    if (!childPlatformsMap.has(stop.parent_station)) {
      childPlatformsMap.set(stop.parent_station, []);
    }
    childPlatformsMap.get(stop.parent_station)!.push(stop.stop_id);
  }
}

console.log(`   Found ${childPlatformsMap.size} stations with child platforms`);

// 7. Load trips to map route_id to trip_id
console.log('\n7️⃣  Loading trips...');
const trips = parseCSV<Trip>(join(gtfsDir, 'trips.txt'));
const tripToRoute = new Map(trips.map(t => [t.trip_id, t.route_id]));
console.log(`   Found ${trips.length} trips`);

// 8. Load stop_times to find which lines serve which parent stations
console.log('\n8️⃣  Loading stop times (this may take a moment)...');
const stopTimes = parseCSV<StopTime>(join(gtfsDir, 'stop_times.txt'));
console.log(`   Found ${stopTimes.length} stop time entries`);

// 9. Build station-to-lines mapping
console.log('\n9️⃣  Building station-to-lines mapping...');
const stationLines = new Map<string, Set<string>>();

for (const stopTime of stopTimes) {
  const stop = allStops.find(s => s.stop_id === stopTime.stop_id);
  if (!stop) continue;

  // Get parent station ID
  const parentId = stop.parent_station || stop.stop_id;

  // Get route for this trip
  const routeId = tripToRoute.get(stopTime.trip_id);
  if (!routeId) continue;

  const lineName = routeMap.get(routeId);
  if (!lineName) continue;

  if (!stationLines.has(parentId)) {
    stationLines.set(parentId, new Set());
  }
  stationLines.get(parentId)!.add(lineName);
}

console.log(`   Mapped lines for ${stationLines.size} stations`);

// 10. Generate enhanced station data
console.log('\n🔟  Generating enhanced station data...');
const stations: Station[] = parentStations.map(stop => {
  const transfers = transferMap.get(stop.stop_id) || [];
  // Sort transfers by time (shortest first)
  transfers.sort((a, b) => a.transferTime - b.transferTime);

  return {
    id: stop.stop_id,
    name: stop.stop_name,
    latitude: parseFloat(stop.stop_lat),
    longitude: parseFloat(stop.stop_lon),
    lines: Array.from(stationLines.get(stop.stop_id) || []).sort(),
    childPlatforms: childPlatformsMap.get(stop.stop_id),
    transfers: transfers.length > 0 ? transfers : undefined
  };
}).filter(station => station.lines.length > 0); // Only include stations with known lines

console.log(`   Generated ${stations.length} stations with enhanced data`);

// 11. Generate nyc-stations.ts TypeScript code
console.log('\n1️⃣1️⃣  Generating nyc-stations.ts...');

function formatStationObject(s: Station): string {
  const lines = [`    id: '${s.id}'`, `    name: '${s.name.replace(/'/g, "\\'")}'`, `    city: 'nyc'`, `    latitude: ${s.latitude}`, `    longitude: ${s.longitude}`, `    lines: [${s.lines.map(l => `'${l}'`).join(', ')}]`];

  if (s.childPlatforms && s.childPlatforms.length > 0) {
    lines.push(`    childPlatforms: [${s.childPlatforms.map(p => `'${p}'`).join(', ')}]`);
  }

  if (s.transfers && s.transfers.length > 0) {
    const transferLines = s.transfers.map(t =>
      `      { toStationId: '${t.toStationId}', toStationName: '${t.toStationName.replace(/'/g, "\\'")}', transferTime: ${t.transferTime}, transferType: '${t.transferType}' }`
    );
    lines.push(`    transfers: [\n${transferLines.join(',\n')}\n    ]`);
  }

  return `  {\n${lines.join(',\n')}\n  }`;
}

const stationsCode = `/**
 * NYC Subway static station data
 * Generated from GTFS static feed
 *
 * Source: MTA GTFS Static Data
 * Generated: ${new Date().toISOString()}
 * Total Stations: ${stations.length}
 */

import { TransitStation } from './base';

export const NYC_STATIONS: TransitStation[] = [
${stations.map(formatStationObject).join(',\n')}
];
`;

const stationsOutputPath = join(process.cwd(), 'src', 'transit', 'nyc-stations.ts');
writeFileSync(stationsOutputPath, stationsCode);
console.log(`   ✅ Generated ${stationsOutputPath}`);

// 12. Generate nyc-routes.ts TypeScript code
console.log('\n1️⃣2️⃣  Generating nyc-routes.ts...');
const routesCode = `/**
 * NYC Subway route information
 * Generated from GTFS static feed
 *
 * Source: MTA GTFS Static Data
 * Generated: ${new Date().toISOString()}
 * Total Routes: ${routeData.length}
 */

import { TransitRoute } from './base';

export const NYC_ROUTES: TransitRoute[] = [
${routeData.map(r => `  {
    routeId: '${r.routeId}',
    shortName: '${r.shortName}',
    longName: '${r.longName.replace(/'/g, "\\'")}',
    description: '${r.description.replace(/'/g, "\\'")}',
    city: 'nyc'
  }`).join(',\n')}
];
`;

const routesOutputPath = join(process.cwd(), 'src', 'transit', 'nyc-routes.ts');
writeFileSync(routesOutputPath, routesCode);
console.log(`   ✅ Generated ${routesOutputPath}`);

// 13. Statistics
console.log(`\n📊 Statistics:`);
console.log(`   Total stations: ${stations.length}`);
console.log(`   Stations with transfers: ${stations.filter(s => s.transfers && s.transfers.length > 0).length}`);
console.log(`   Stations with child platforms: ${stations.filter(s => s.childPlatforms && s.childPlatforms.length > 0).length}`);
console.log(`   Total routes: ${routeData.length}`);
console.log(`   Lines covered: ${new Set(stations.flatMap(s => s.lines)).size}`);
console.log(`   Average lines per station: ${(stations.reduce((sum, s) => sum + s.lines.length, 0) / stations.length).toFixed(1)}`);

// Show top transfer hubs
const topHubs = stations
  .sort((a, b) => (b.transfers?.length || 0) - (a.transfers?.length || 0))
  .slice(0, 10)
  .filter(s => s.transfers && s.transfers.length > 0);

console.log(`\n🚇 Top 10 transfer hubs:`);
topHubs.forEach((station, i) => {
  console.log(`   ${i + 1}. ${station.name} - ${station.transfers!.length} connections`);
});

console.log('\n✨ Done! Files generated:\n   - src/transit/nyc-stations.ts\n   - src/transit/nyc-routes.ts\n');
