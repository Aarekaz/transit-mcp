import { AsyncLocalStorage } from 'node:async_hooks';
import { getStaticSources } from './transit/gtfs/refresh/policy';

export interface TelemetryInput extends Record<string, unknown> {
  correlationId?: unknown;
  era?: unknown;
  protocolVersion?: unknown;
  mcpMethod?: unknown;
  mcpName?: unknown;
  clientName?: unknown;
  sessionId?: unknown;
  alias?: unknown;
  upstream?: unknown;
  durationMs?: unknown;
  status?: unknown;
  /** Regions and static feeds the answer drew on, read from its transit refs. */
  coverage?: unknown;
  feeds?: unknown;
}

export interface SafeTelemetry {
  era?: 'modern' | 'legacy';
  protocolVersion?: string;
  mcpMethod?: string;
  mcpName?: string;
  clientName?: string;
  alias?: '/mcp' | '/sse';
  upstream?: string;
  durationMs?: number;
  statusClass?: `${1 | 2 | 3 | 4 | 5}xx`;
  coverage?: string;
  feeds?: string;
}

/** The telemetry of the request being served, so a tool can note what its answer used. */
export const requestTelemetry = new AsyncLocalStorage<TelemetryInput>();

/** Known values only, sorted and joined: never a place, stop or route. */
function knownSet(value: unknown, allowed: readonly string[]): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = [...new Set(value.filter((item): item is string => typeof item === 'string' && allowed.includes(item)))].sort();
  return kept.length ? kept.join('+') : undefined;
}

// Finite, server-owned categories: regex validation alone permits identifiers,
// coordinates, keys and place names to be smuggled into otherwise safe fields.
export const TELEMETRY_TOOLS = [
  'find_transit', 'plan_trip', 'get_departures', 'get_service_status', 'get_vehicle_status',
  'get_station_predictions', 'search_stations', 'get_stations_by_line', 'get_all_stations',
  'get_station_transfers', 'get_incidents', 'get_elevator_incidents', 'get_route_info',
  'get_train_positions', 'get_bus_predictions', 'get_bus_routes', 'get_bus_stops', 'get_bus_positions',
] as const;
export const TELEMETRY_CLIENTS = ['ChatGPT', 'openai-mcp', 'Claude Desktop', 'claude-ai', 'transit-prompt-evals'] as const;
export const TELEMETRY_ENVIRONMENTS = ['production', 'preview', 'development', 'test'] as const;
export function telemetryCategory(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : 'unclassified';
}
function known(value: unknown, allowed: readonly string[]): string | undefined {
  const category = telemetryCategory(value, allowed);
  return category === 'unclassified' ? undefined : category;
}

function addIfDefined<Key extends keyof SafeTelemetry>(
  target: SafeTelemetry,
  key: Key,
  value: SafeTelemetry[Key] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/** Build a new allowlisted object; unknown input keys are never copied. */
export function sanitizeTelemetry(input: TelemetryInput): SafeTelemetry {
  const safe: SafeTelemetry = {};
  addIfDefined(
    safe,
    'era',
    input.era === 'modern' || input.era === 'legacy' ? input.era : undefined,
  );
  addIfDefined(
    safe,
    'protocolVersion',
    known(input.protocolVersion, ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']),
  );
  addIfDefined(
    safe,
    'mcpMethod',
    known(input.mcpMethod, ['initialize', 'ping', 'tools/call', 'tools/list', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get', 'completion/complete', 'notifications/initialized', 'notifications/cancelled']),
  );
  addIfDefined(safe, 'mcpName', known(input.mcpName, TELEMETRY_TOOLS));
  addIfDefined(
    safe,
    'alias',
    input.alias === '/mcp' || input.alias === '/sse' ? input.alias : undefined,
  );
  addIfDefined(safe, 'upstream', known(input.upstream, ['wmata', 'mta', 'sf511']));
  addIfDefined(
    safe,
    'durationMs',
    typeof input.durationMs === 'number'
      && Number.isFinite(input.durationMs)
      && input.durationMs >= 0
      ? input.durationMs
      : undefined,
  );
  if (input.clientName !== undefined) safe.clientName = telemetryCategory(input.clientName, TELEMETRY_CLIENTS);
  const sources = getStaticSources();
  addIfDefined(safe, 'coverage', knownSet(input.coverage, [...new Set(sources.map(source => source.coverageId))]));
  addIfDefined(safe, 'feeds', knownSet(input.feeds, sources.map(source => source.feedId)));
  if (typeof input.status === 'number'
    && Number.isInteger(input.status)
    && input.status >= 100
    && input.status <= 599) {
    safe.statusClass = `${Math.floor(input.status / 100)}xx` as SafeTelemetry['statusClass'];
  }
  return safe;
}

export function serializeTelemetry(input: TelemetryInput): string {
  return JSON.stringify(sanitizeTelemetry(input));
}
