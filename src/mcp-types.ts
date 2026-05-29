export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
}

/**
 * Tool behavior hints (MCP 2025-06-18). Clients use these as UI cues —
 * e.g., to label a tool as safe (readOnly) or require confirmation
 * before invoking (destructive).
 */
export interface MCPToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface MCPJSONSchema {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
}

export interface MCPTool {
  name: string;
  /** Human-readable title (MCP 2025-06-18). Falls back to name if absent. */
  title?: string;
  description: string;
  inputSchema: MCPJSONSchema;
  /** Schema for `structuredContent` in tool results (MCP 2025-06-18). */
  outputSchema?: MCPJSONSchema;
  annotations?: MCPToolAnnotations;
}

export interface MCPToolContent {
  type: 'text';
  text: string;
}

/**
 * Tool result. `content` is preserved for client compatibility;
 * `structuredContent` (MCP 2025-06-18) carries the typed object so
 * clients can consume it without re-parsing the text payload.
 */
export interface MCPToolResult {
  content: MCPToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface MCPSession {
  sessionId: string;           // UUID v4
  userId: string;              // From JWT
  createdAt: number;           // Unix timestamp (milliseconds)
  lastEventId: number;         // Timestamp of last SSE event (ms)
  protocolVersion: string;     // MCP protocol version
}
