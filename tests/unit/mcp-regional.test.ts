import { describe, expect, it } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import { createMetroMcpServer } from '../../src/mcp/server';
import { createMockEnv } from '../setup';

describe('Bay Area MCP rollout', () => {
  it('is absent by default and registers an attributed vehicle tool only when on', async () => {
    const darkServer = createMetroMcpServer({ env: createMockEnv(), era: 'modern' });
    const darkTools = (darkServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(darkTools.get_vehicle_positions).toBeUndefined();

    const env = { ...createMockEnv(), SFBAY_MODE: 'on' as const };
    const server = createMetroMcpServer({
      env,
      era: 'modern',
      deps: {
        regionalTransitService: {
          getVehiclePositions: async () => ({
            freshness: 'fresh',
            producerTimestampSeconds: 1_000,
            receivedAtSeconds: 1_001,
            warnings: [],
            payload: [{ entityId: 'entity-1', vehicleId: 'vehicle-1', latitude: 37.77, longitude: -122.42 }],
          }),
        },
      },
    });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, context: ServerContext) => Promise<unknown> }> })._registeredTools;
    const result = await tools.get_vehicle_positions!.handler(
      { city: 'sfbay' },
      { mcpReq: { signal: new AbortController().signal } } as ServerContext,
    ) as { structuredContent: Record<string, unknown> };

    expect(result.structuredContent).toMatchObject({
      city: 'sfbay', freshness: 'fresh',
      attribution: { text: expect.stringContaining('511 SF Bay') },
      vehicles: [{ id: 'vehicle-1' }],
    });
  });
});
