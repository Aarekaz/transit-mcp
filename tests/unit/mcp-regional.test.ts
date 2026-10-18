import { describe, expect, it } from 'vitest';
import { createMetroMcpServer } from '../../src/mcp/server';
import { createMockEnv } from '../setup';
import { EXPECTED_CATALOG_TOOL_NAMES } from '../fixtures/mcp-contracts';

describe('Bay Area MCP rollout', () => {
  it.each(['off', 'dark', 'on', 'suspended'] as const)('keeps the global catalog in %s mode without regional aliases', mode => {
    const server = createMetroMcpServer({ env: createMockEnv({ SFBAY_MODE: mode }), era: 'modern' });
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toEqual(EXPECTED_CATALOG_TOOL_NAMES);
  });
});
