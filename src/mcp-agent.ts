import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Env } from './types';
import { SERVER_VERSION } from './config';

/**
 * Per-session authentication context, propagated from the JWT verified
 * at the Worker shell. The DO can read these without re-verifying the
 * token on every message — verification happens once at session start.
 */
export interface Props extends Record<string, unknown> {
  userId: string;
  userLogin: string;
  /** RFC 8707 audience bound to this token, if any. Absent on legacy tokens. */
  audience?: string;
}

/**
 * MetroMcpAgent — Durable Object-backed MCP server.
 *
 * Inherits from cloudflare/agents' McpAgent (which extends Agent → DurableObject)
 * to get a managed session lifecycle:
 *
 *   - One DO instance per Mcp-Session-Id (auto-issued on initialize)
 *   - Streamable HTTP, SSE, and RPC transports (`transport: "auto"`)
 *   - Hibernatable WebSockets — DO evicts while idle, costs nothing
 *   - DurableObjectEventStore — Last-Event-ID replay for resumability
 *   - elicitInput() — server-initiated user prompts (MCP 2025-06-18)
 *   - sendResourceUpdated() — push to subscribed clients
 *
 * Tools, resources, and prompts are registered in init() — subsequent
 * commits migrate the 13 tool handlers and add the resources/prompts
 * surfaces.
 */
export class MetroMcpAgent extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: 'metro-mcp',
    version: SERVER_VERSION
  });

  async init(): Promise<void> {
    // Tool / resource / prompt registration lands in subsequent commits.
  }
}
