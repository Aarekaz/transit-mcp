import { createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createMetroMcpServer } from '../../src/mcp/server';
import { modernMcpRequest, readMcpResponse } from '../helpers/mcp-request';
import { createMockEnv } from '../setup';

describe('product-specific MCP 2026 protocol profile', () => {
  it('advertises only implemented capabilities and rejects unadvertised completion requests', async () => {
    const handler = createMcpHandler(ctx => createMetroMcpServer({ env: createMockEnv({ SFBAY_MODE: 'dark' }), era: ctx.era }));
    try {
      const [discovery] = await readMcpResponse(await handler.fetch(await modernMcpRequest('server/discover')));
      const capabilities = (discovery as { result: { capabilities: Record<string, unknown> } }).result.capabilities;
      expect(Object.keys(capabilities).sort()).toEqual(['extensions', 'prompts', 'resources', 'tools']);
      const [completion] = await readMcpResponse(await handler.fetch(await modernMcpRequest('completion/complete', {
        ref: { type: 'ref/prompt', name: 'commute-planner' }, argument: { name: 'city', value: 'd' },
      })));
      expect(completion).toMatchObject({ error: { code: -32601 } });
    } finally { await handler.close(); }
  });

  it('returns only a text/structured final response without unsolicited requests or logging for real discovery calls', async () => {
    const handler = createMcpHandler(ctx => createMetroMcpServer({ env: createMockEnv({ SFBAY_MODE: 'dark' }), era: ctx.era }));
    try {
      const messages = await readMcpResponse(await handler.fetch(await modernMcpRequest('tools/call', {
        name: 'find_transit', arguments: { query: 'dc' },
      })));
      expect(messages).toHaveLength(1);
      expect(messages[0]).not.toHaveProperty('method');
      const result = (messages[0] as { result: { content: Array<{ type: string; text: string }>; structuredContent: unknown } }).result;
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe('text');
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    } finally { await handler.close(); }
  });
});
