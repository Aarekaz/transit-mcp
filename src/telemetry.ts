export interface TelemetryInput extends Record<string, unknown> {
  correlationId?: unknown;
  era?: unknown;
  protocolVersion?: unknown;
  mcpMethod?: unknown;
  mcpName?: unknown;
  alias?: unknown;
  clientId?: unknown;
  upstream?: unknown;
  durationMs?: unknown;
  status?: unknown;
}

export interface SafeTelemetry {
  correlationId?: string;
  era?: 'modern' | 'legacy';
  protocolVersion?: string;
  mcpMethod?: string;
  mcpName?: string;
  alias?: '/mcp' | '/sse';
  clientId?: string;
  upstream?: string;
  durationMs?: number;
  statusClass?: `${1 | 2 | 3 | 4 | 5}xx`;
}

function safeString(value: unknown, pattern: RegExp, maxLength: number): string | undefined {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value)
    ? value
    : undefined;
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
  addIfDefined(safe, 'correlationId', safeString(input.correlationId, /^[A-Za-z0-9._:-]+$/, 128));
  addIfDefined(
    safe,
    'era',
    input.era === 'modern' || input.era === 'legacy' ? input.era : undefined,
  );
  addIfDefined(
    safe,
    'protocolVersion',
    safeString(input.protocolVersion, /^\d{4}-\d{2}-\d{2}$/, 10),
  );
  addIfDefined(
    safe,
    'mcpMethod',
    safeString(input.mcpMethod, /^[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/, 128),
  );
  addIfDefined(safe, 'mcpName', safeString(input.mcpName, /^[A-Za-z0-9_.:-]+$/, 128));
  addIfDefined(
    safe,
    'alias',
    input.alias === '/mcp' || input.alias === '/sse' ? input.alias : undefined,
  );
  addIfDefined(safe, 'clientId', safeString(input.clientId, /^[^\u0000-\u001f\u007f]+$/, 512));
  addIfDefined(safe, 'upstream', safeString(input.upstream, /^[a-z0-9][a-z0-9._-]*$/, 64));
  addIfDefined(
    safe,
    'durationMs',
    typeof input.durationMs === 'number'
      && Number.isFinite(input.durationMs)
      && input.durationMs >= 0
      ? input.durationMs
      : undefined,
  );
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
