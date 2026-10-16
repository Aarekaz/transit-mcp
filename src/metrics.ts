import { sanitizeTelemetry, type TelemetryInput } from './telemetry';
import type { Env } from './types';

/** Analytics Engine rejects a data point whose index exceeds 96 bytes. */
const MAX_INDEX_BYTES = 96;

/**
 * Usage counting for honest public numbers ("tool calls per week" instead
 * of raw HTTP invocations). One Analytics Engine data point per initialize
 * and per tools/call request:
 *
 *   indexes: [sessionId]                ('' when the client sent none)
 *   blobs:   [method, toolName, clientName, environment, statusClass]
 *   doubles: [durationMs]
 *
 * The transport is stateless and never issues Mcp-Session-Id, and MCP
 * 2026-07-28 removes sessions and initialize entirely, so the index is
 * normally ''. Count connections from legacy initialize rows instead.
 *
 * Only telemetry-allowlisted fields are recorded: never tool arguments,
 * never request bodies, never IP addresses. Fire-and-forget by design —
 * a metrics failure must never affect a request, and the binding is
 * optional so local dev and tests run without it.
 */
export function recordMcpUsage(env: Env, telemetry: TelemetryInput): void {
  try {
    const dataset = env.ANALYTICS;
    if (!dataset) return;

    const safe = sanitizeTelemetry(telemetry);
    if (safe.mcpMethod !== 'tools/call' && safe.mcpMethod !== 'initialize') return;

    // Sanitized session IDs are ASCII, so length equals byte length.
    const sessionId = safe.sessionId !== undefined && safe.sessionId.length <= MAX_INDEX_BYTES
      ? safe.sessionId
      : '';
    dataset.writeDataPoint({
      indexes: [sessionId],
      blobs: [
        safe.mcpMethod,
        safe.mcpName ?? '',
        safe.clientName ?? '',
        typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT : '',
        safe.statusClass ?? '',
      ],
      doubles: [safe.durationMs ?? 0],
    });
  } catch {
    // Analytics is best-effort; swallow everything.
  }
}
