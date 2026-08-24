import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getServerInfo } from '../../src/server-info';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url).pathname, 'utf8'),
);
const exampleClientConfig = JSON.parse(
  readFileSync(new URL('../../mcp-config.json', import.meta.url).pathname, 'utf8'),
);

describe('getServerInfo', () => {
  it('publishes the Metro MCP 6.0 anonymous stateless MCP 2026 contract', () => {
    const body = getServerInfo('https://metro-mcp.anuragd.me', '2026-08-13T12:00:00.000Z');

    expect(body.version).toBe('6.0.0');
    expect(body.protocolVersion).toBe('2026-07-28');
    expect(body.links.mcpServer).toBe('https://metro-mcp.anuragd.me/mcp');
    expect(body.endpoints.mcpRecommended).toBe('/mcp');
    expect(body.authentication).toEqual({ type: 'none' });
    expect(body.endpoints).not.toHaveProperty('oauth');
    expect(body.endpoints).not.toHaveProperty('discovery');
    expect(body.stats).toMatchObject({
      toolsAvailable: 13,
      resourcesAvailable: 3,
      promptsAvailable: 3,
    });
    expect(body.tools).toHaveLength(13);
    expect(new Set(body.tools)).toHaveLength(13);
    expect(body.transport).toMatchObject({
      type: 'streamable-http',
      stateless: true,
      supportsServerPush: false,
      supportsResumability: false,
    });
    expect(body.transport).not.toHaveProperty('session');
    expect(body.transport).not.toHaveProperty('sessions');
    expect(body.capabilities.tools).toEqual({});
    expect(body.capabilities.tools).not.toHaveProperty('listChanged');
  });

  it('keeps release and client configuration metadata aligned', () => {
    expect(packageJson.version).toBe('6.0.0');
    expect(exampleClientConfig.mcpServers['metro-mcp']).toEqual({
      type: 'http',
      url: 'https://metro-mcp.anuragd.me/mcp',
    });
  });

  it('publishes canonical anonymous connection and legal links', () => {
    const body = getServerInfo('https://metro-mcp.anuragd.me', '2026-08-21T12:00:00.000Z');

    expect(body.links).toMatchObject({
      github: 'https://github.com/Aarekaz/metro-mcp',
      mcpServer: 'https://metro-mcp.anuragd.me/mcp',
      mcpServerLegacy: 'https://metro-mcp.anuragd.me/sse',
      documentation: 'https://metro-mcp.anuragd.me/docs/',
      privacy: 'https://metro-mcp.anuragd.me/privacy/',
      terms: 'https://metro-mcp.anuragd.me/terms/',
      support: 'https://metro-mcp.anuragd.me/support/',
    });
  });

  it('reports the current official station totals', () => {
    const body = getServerInfo('https://metro-mcp.example.test', '2026-06-10T19:00:00.000Z');

    expect(body.cities.find(city => city.code === 'dc')?.stations).toBe(102);
    expect(body.cities.find(city => city.code === 'nyc')?.stations).toBe(496);
    expect(body.stats.totalStations).toBe(598);
  });

  it('describes the stateless MCP transport without claiming resumability', () => {
    const body = getServerInfo('https://metro-mcp.example.test', '2026-08-13T12:00:00.000Z');

    expect(body.transport.type).toBe('streamable-http');
    expect(body.transport.note).toContain('stateless');
    expect(body.transport.note).not.toContain('Durable Object');
    expect(body.transport.supportsServerPush).toBe(false);
    expect(body.transport.supportsResumability).toBe(false);
  });
});
