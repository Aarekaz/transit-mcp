import { MCPResponse } from '../mcp-types';

/**
 * Formats a single JSON-RPC message as a Server-Sent Event
 *
 * SSE format according to HTML5 spec:
 * id: <event-id>
 * data: <json-message>
 * \n\n (blank line terminates the event)
 *
 * @param message - The MCP JSON-RPC response to format
 * @param eventId - Unique event ID for SSE resumability
 * @returns Formatted SSE message string
 */
export function formatSSEMessage(message: MCPResponse, eventId: string): string {
  const jsonData = JSON.stringify(message);

  // SSE format requires each line of data to be prefixed with "data: "
  // For single-line JSON, we can use a single data field
  return `id: ${eventId}\ndata: ${jsonData}\n\n`;
}

/**
 * Creates an HTTP Response with Server-Sent Events format
 *
 * @param message - The MCP JSON-RPC response to send
 * @param eventId - Unique event ID for this message
 * @returns Response object with text/event-stream content-type
 */
export function createSSEResponse(message: MCPResponse, eventId: string): Response {
  const sseMessage = formatSSEMessage(message, eventId);

  return new Response(sseMessage, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}

/**
 * Creates a streaming SSE Response for multiple messages
 * Useful for server-initiated notifications or batched responses
 *
 * @param messages - Array of MCP JSON-RPC responses
 * @param startEventId - Starting event ID (will increment for each message)
 * @returns Response object with streaming SSE content
 */
export function createSSEStream(messages: MCPResponse[], startEventId = 0): Response {
  const stream = new ReadableStream({
    start(controller) {
      // Encode and send each message as an SSE event
      messages.forEach((message, index) => {
        const eventId = `${startEventId + index}`;
        const sseMessage = formatSSEMessage(message, eventId);
        controller.enqueue(new TextEncoder().encode(sseMessage));
      });

      // Close the stream after all messages are sent
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Creates a persistent SSE stream that stays open for server-initiated messages
 *
 * This is useful for GET /sse endpoints where the server needs to push
 * notifications to the client
 *
 * @returns Response object with an open ReadableStream
 */
export function createPersistentSSEStream(): {
  response: Response;
  send: (message: MCPResponse, eventId: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController | null = null;

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
      // Send initial comment to establish connection
      controller.enqueue(
        new TextEncoder().encode(': Connected to Metro MCP\n\n')
      );
    },
    cancel() {
      controller = null;
    },
  });

  const response = new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });

  return {
    response,
    send: (message: MCPResponse, eventId: string) => {
      if (controller) {
        const sseMessage = formatSSEMessage(message, eventId);
        controller.enqueue(new TextEncoder().encode(sseMessage));
      }
    },
    close: () => {
      if (controller) {
        controller.close();
        controller = null;
      }
    },
  };
}
