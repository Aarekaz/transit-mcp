import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../../src/config';
import { SERVER_IDENTITY } from '../../src/mcp/server';
import { getServerInfo } from '../../src/server-info';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url).pathname, 'utf8'),
);
const exampleClientConfig = JSON.parse(
  readFileSync(new URL('../../mcp-config.json', import.meta.url).pathname, 'utf8'),
);
const registryServer = JSON.parse(
  readFileSync(new URL('../../server.json', import.meta.url).pathname, 'utf8'),
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
    expect(exampleClientConfig.mcpServers['transit-mcp']).toEqual({
      type: 'http',
      url: 'https://transitmcp.com/mcp',
    });
  });

  it('keeps the MCP Registry server.json aligned with the served identity', () => {
    expect(registryServer.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    );
    expect(registryServer.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(registryServer.description.length).toBeLessThanOrEqual(100);
    expect(registryServer.version).toBe(SERVER_VERSION);
    expect(registryServer.version).toBe(packageJson.version);
    expect(registryServer.title).toBe(SERVER_IDENTITY.title);
    expect(registryServer.websiteUrl).toBe(SERVER_IDENTITY.websiteUrl);
    expect(registryServer.icons).toEqual(SERVER_IDENTITY.icons);
    expect(registryServer.remotes).toEqual([
      { type: 'streamable-http', url: exampleClientConfig.mcpServers['transit-mcp'].url },
    ]);
  });

  it('publishes canonical anonymous connection and legal links', () => {
    const body = getServerInfo('https://transitmcp.com', '2026-08-21T12:00:00.000Z');

    expect(body.name).toBe('Transit MCP');
    expect(body.links).toMatchObject({
      github: 'https://github.com/Aarekaz/metro-mcp',
      mcpServer: 'https://transitmcp.com/mcp',
      mcpServerLegacy: 'https://transitmcp.com/sse',
      documentation: 'https://transitmcp.com/docs/',
      privacy: 'https://transitmcp.com/privacy/',
      terms: 'https://transitmcp.com/terms/',
      support: 'https://transitmcp.com/support/',
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
