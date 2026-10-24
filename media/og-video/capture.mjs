// Asks the live server the three questions the film shows, and saves what it answered to live.js.
//   node capture.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'https://transitmcp.com/mcp';

async function call(name, args) {
  const started = Date.now();
  const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'user-agent': 'curl/8' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await response.text();
  const json = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? text);
  const result = json.result?.structuredContent;
  if (!result || json.result.isError) throw new Error(`${name} ${JSON.stringify(args)}: ${JSON.stringify(result ?? json).slice(0, 300)}`);
  return { result, ms: Date.now() - started };
}
const minutes = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
// "7:40 PM" in the agency's own time zone.
const clock = (iso, timeZone) => new Date(iso).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
const day = (iso, timeZone) => new Date(iso).toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });

// New York: the next uptown 1 at 14 St. "14 St" is several stations; the 1's is chosen by its lines.
const found = await call('find_transit', { coverage: 'nyc', query: '14 St' });
const station = found.result.candidates.find(c => c.kind === 'stop' && c.routeNames?.includes('1') && c.stopType === 'station') ?? found.result.candidates.find(c => c.routeNames?.includes('1'));
const board = await call('get_departures', { stopRef: station.ref, limit: 30 });
const uptown = board.result.departures.filter(d => /Van Cortlandt|242/i.test(d.headsign ?? ''));
const now = board.result.asOf, next = uptown.map(d => minutes(now, d.departureTime ?? d.predictedTime ?? d.scheduledTime));
const NY = 'America/New_York';
const nyc = { ask: 'Next uptown 1 train at 14 St?', tool: 'get_departures', status: uptown[0].status ?? board.result.status,
  big: String(next[0]), unit: 'min', route: '1', routeLabel: `Uptown to ${uptown[0].headsign.replace('-', '–')}`, then: next.length > 2 ? `Then ${next[1]} and ${next[2]} min` : '', asOf: clock(now, NY), day: day(now, NY), zone: 'ET' };

async function trip(coverage, from, to, zone, timeZone, operator = '') {
  const plan = await call('plan_trip', { coverage, origin: { query: from }, destination: { query: to } });
  const it = plan.result.itineraries[0], rides = it.steps.filter(s => s.kind === 'ride'), ride = rides[0];
  return { tool: 'plan_trip', status: it.status, big: String(minutes(it.departureTime, it.arrivalTime)), unit: 'min',
    route: ride.routeName, routeLabel: `${operator}${ride.routeName.replace(/-[NS]$/, '')}${/^(Red|Blue|Green|Orange|Yellow|Silver)(-[NS])?$/.test(ride.routeName) ? ' Line' : ''} toward ${ride.headsign.split('/').pop().trim()}`,
    then: `Leaves ${clock(it.departureTime, timeZone)} · ${rides.length - 1 ? `${rides.length - 1} change` : 'no changes'}`, asOf: clock(plan.result.asOf, timeZone), day: day(plan.result.asOf, timeZone), zone };
}
const dc = { ask: 'Union Station to Chinatown?', ...await trip('dc', 'Union Station', 'Chinatown', 'ET', NY) };
const sfbay = { ask: 'Fastest way from SFO to Powell St?', ...await trip('sfbay', 'SFO', 'Powell St', 'PT', 'America/Los_Angeles', 'BART ') };

const live = { recorded: new Date().toISOString(), nyc, dc, sfbay };
writeFileSync(join(here, 'live.js'), `// Recorded from ${ENDPOINT} by capture.mjs.\nwindow.LIVE = ${JSON.stringify(live, null, 1)};\n`);
console.log(JSON.stringify(live, null, 1));
