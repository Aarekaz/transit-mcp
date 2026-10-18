import { sanitizeTelemetry, telemetryCategory, TELEMETRY_ENVIRONMENTS, type TelemetryInput } from './telemetry';
import type { Env } from './types';

/**
 * Usage counting for honest public numbers ("tool calls per week" instead
 * of raw HTTP invocations). One Analytics Engine data point per initialize
 * and per tools/call request:
 *
 *   indexes: ['']                      (never a session or user identifier)
 *   blobs:   [method, toolName, clientName, environment, statusClass]
 *   doubles: [durationMs]
 *
 * The transport is stateless and never issues Mcp-Session-Id, and MCP
 * 2026-07-28 removes sessions and initialize entirely, so the index is
 * always ''. Legacy initialize rows are compatibility events, not tool calls,
 * users, sessions or evidence of human traffic. Status is HTTP status only;
 * an HTTP 2xx response can still carry a tool or protocol error.
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
    if (safe.mcpMethod === 'initialize' && safe.era === 'modern') return;

    dataset.writeDataPoint({
      indexes: [''],
      blobs: [
        safe.mcpMethod,
        safe.mcpName ?? '',
        safe.clientName ?? 'unclassified',
        telemetryCategory(env.ENVIRONMENT, TELEMETRY_ENVIRONMENTS),
        safe.statusClass ?? '',
      ],
      doubles: [safe.durationMs ?? 0],
    });
  } catch {
    // Analytics is best-effort; swallow everything.
  }
}
