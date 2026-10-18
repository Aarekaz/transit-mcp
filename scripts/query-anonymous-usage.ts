import process from 'node:process';
import { parseArgs } from 'node:util';
import { TELEMETRY_CLIENTS, TELEMETRY_ENVIRONMENTS, TELEMETRY_TOOLS, telemetryCategory } from '../src/telemetry';

export interface UsageQueryOptions {
  start: string;
  end: string;
  environment: string;
  excludeClients?: string[];
}
const statuses = ['1xx', '2xx', '3xx', '4xx', '5xx'];
export const usageLimitations = [
  'Counts are sampling-weighted estimates of recorded requests; missing telemetry and retention gaps cannot be recovered.',
  'HTTP 2xx counts include possible tool errors and protocol errors; this schema cannot establish successful transit answers.',
  'Client categories are self-reported software names, not identities. Unknown or absent names are unclassified.',
  'No user, human, real-traffic, session or unique-client counts can be inferred. Legacy initialize events are separate from tool calls.',
  'Only the explicit environment and client filters exclude traffic. Untagged synthetic traffic remains included.',
  'Dates and daily buckets are UTC; start is inclusive and end is exclusive. Historical rows are normalized without reading identifiers.',
];
const literals = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ');
const categorySql = (column: string, allowed: readonly string[]) => `if(${column} IN (${literals(allowed)}), ${column}, 'unclassified')`;
function validDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Pure fixed-schema SELECT builder; no raw SQL, dimensions, dataset or identifiers from callers. */
export function buildUsageQuery(options: UsageQueryOptions): string {
  if (!validDay(options.start) || !validDay(options.end) || options.end <= options.start
    || Date.parse(options.end) - Date.parse(options.start) > 31 * 86400000) throw new Error('Use a valid UTC date range of 1 to 31 days');
  if (!TELEMETRY_ENVIRONMENTS.includes(options.environment as typeof TELEMETRY_ENVIRONMENTS[number])) throw new Error('Select an explicit supported environment');
  const excluded = options.excludeClients ?? [];
  if (excluded.some(client => !TELEMETRY_CLIENTS.includes(client as typeof TELEMETRY_CLIENTS[number]))) throw new Error('Only documented client categories can be excluded');
  return `SELECT formatDateTime(timestamp, '%Y-%m-%d', 'UTC') AS day, blob1 AS method,
  ${categorySql('blob2', TELEMETRY_TOOLS)} AS tool,
  ${categorySql('blob3', TELEMETRY_CLIENTS)} AS client,
  ${categorySql('blob4', TELEMETRY_ENVIRONMENTS)} AS environment,
  ${categorySql('blob5', statuses)} AS status, SUM(_sample_interval) AS count
FROM mcp_usage
WHERE timestamp >= toDateTime('${options.start} 00:00:00', 'UTC')
  AND timestamp < toDateTime('${options.end} 00:00:00', 'UTC')
  AND blob1 IN ('tools/call', 'initialize') AND blob4 = '${options.environment}'${excluded.length ? `
  AND blob3 NOT IN (${literals(excluded)})` : ''}
GROUP BY day, method, tool, client, environment, status
ORDER BY day, method, tool, client, environment, status
LIMIT 100000 FORMAT JSON`;
}

/** Rebuild the report from allowlisted aggregates, even for historical rows. */
export function summarizeUsage(rows: unknown[]) {
  if (rows.length >= 100000) throw new Error('Result may be truncated; narrow the date range');
  const report = { toolCalls: 0, httpSuccessfulToolCalls: 0, legacyInitializeEvents: 0,
    daily: {} as Record<string, number>, tools: { unclassified: 0 } as Record<string, number>,
    clients: { unclassified: 0 } as Record<string, number>, environments: {} as Record<string, number>,
    statuses: {} as Record<string, number>, limitations: usageLimitations };
  const increment = (counts: Record<string, number>, key: string, count: number) => { counts[key] = (counts[key] ?? 0) + count; };
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid aggregate row');
    const row = raw as Record<string, unknown>;
    if (row.method !== 'tools/call' && row.method !== 'initialize') continue;
    const count = typeof row.count === 'string' && /^\d+(?:\.\d+)?$/.test(row.count) ? Number(row.count) : row.count;
    if (!validDay(row.day) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid aggregate row');
    if (row.method === 'initialize') { report.legacyInitializeEvents += count; continue; }
    report.toolCalls += count;
    if (row.status === '2xx') report.httpSuccessfulToolCalls += count;
    increment(report.daily, row.day, count);
    increment(report.tools, telemetryCategory(row.tool, TELEMETRY_TOOLS), count);
    increment(report.clients, telemetryCategory(row.client, TELEMETRY_CLIENTS), count);
    increment(report.environments, telemetryCategory(row.environment, TELEMETRY_ENVIRONMENTS), count);
    increment(report.statuses, telemetryCategory(row.status, statuses), count);
  }
  return report;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    start: { type: 'string' }, end: { type: 'string' }, environment: { type: 'string' },
    'exclude-client': { type: 'string', multiple: true }, execute: { type: 'boolean', default: false },
  } });
  const options = { start: values.start ?? '', end: values.end ?? '', environment: values.environment ?? '', excludeClients: values['exclude-client'] ?? [] };
  const sql = buildUsageQuery(options);
  if (!values.execute) { console.info(JSON.stringify({ mode: 'dry-run', filters: options, sql, limitations: usageLimitations }, null, 2)); return; }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !token) throw new Error('Credentials required');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: sql, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Usage query failed');
  const body = await response.json() as { data?: unknown[] };
  if (!Array.isArray(body.data)) throw new Error('Invalid aggregate response');
  console.info(JSON.stringify({ mode: 'query', filters: options, ...summarizeUsage(body.data) }, null, 2));
}
// Bun entry point only: importing pure helpers never performs network requests.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch(() => {
    console.error('Usage report failed. Check dates (1–31 days), environment, documented client filters and read-only Analytics credentials. Raw errors are suppressed.');
    process.exitCode = 1;
  });
}
