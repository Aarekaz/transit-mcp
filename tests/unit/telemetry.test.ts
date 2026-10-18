import { describe, expect, it } from 'vitest';

import { serializeTelemetry } from '../../src/telemetry';

describe('serializeTelemetry', () => {
  it('serializes only the documented safe fields', () => {
    const serialized = serializeTelemetry({
      era: 'modern',
      protocolVersion: '2026-07-28',
      mcpMethod: 'tools/call',
      mcpName: 'get_station_predictions',
      alias: '/sse',
      upstream: 'wmata',
      durationMs: 18.75,
      status: 204,
      authorization: 'Bearer authorization-secret',
      accessToken: 'access-token-secret',
      refreshToken: 'refresh-token-secret',
      token: 'token-secret',
      code: 'authorization-code-secret',
      props: { userId: '42', githubToken: 'github-secret' },
      body: { station: 'secret-form-value' },
      state: 'mrtr-state-secret',
      form: new FormData(),
    });

    expect(JSON.parse(serialized)).toEqual({
      era: 'modern',
      protocolVersion: '2026-07-28',
      mcpMethod: 'tools/call',
      mcpName: 'get_station_predictions',
      alias: '/sse',
      upstream: 'wmata',
      durationMs: 18.75,
      statusClass: '2xx',
    });
    for (const secret of [
      'authorization-secret',
      'access-token-secret',
      'refresh-token-secret',
      'token-secret',
      'authorization-code-secret',
      'github-secret',
      'secret-form-value',
      'mrtr-state-secret',
      'userId',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('drops malformed safe-field candidates rather than serializing attacker-controlled data', () => {
    expect(JSON.parse(serializeTelemetry({
      correlationId: 'line\nbreak',
      era: 'future',
      protocolVersion: 'secret',
      mcpMethod: 'tools/call\r\nAuthorization: secret',
      mcpName: { token: 'secret' },
      alias: '/sse/messages',
      upstream: 'other\rsecret',
      durationMs: -1,
      status: 999,
    }))).toEqual({});
  });
});

describe('serializeTelemetry usage fields', () => {
  it('keeps only a known software category and drops even well-formed identifiers', () => {
    expect(JSON.parse(serializeTelemetry({
      mcpMethod: 'initialize',
      clientName: 'Claude Desktop',
      sessionId: 'abc-123_XYZ',
    }))).toEqual({
      mcpMethod: 'initialize',
      clientName: 'Claude Desktop',
    });
  });

  it('drops malformed client names and session ids', () => {
    expect(JSON.parse(serializeTelemetry({
      clientName: 'evil<script>',
      sessionId: 'has space',
    }))).toEqual({ clientName: 'unclassified' });
  });

  it('never serializes request/location data smuggled through permitted string fields', () => {
    const serialized = serializeTelemetry({
      correlationId: 'stable-user-123', sessionId: 'stable-session-123',
      clientName: 'Home Address', mcpName: 'tr:sfbay:sf511:stop:abc',
      mcpMethod: 'secret/place', upstream: 'private-api-key', protocolVersion: '1234-12-12',
      arguments: { origin: 'home', destination: 'work', latitude: 37.1, longitude: -122.2 },
      query: 'Home Address', refs: ['tr:sfbay:sf511:stop:abc'], itinerary: { secret: true },
      ip: '192.0.2.1', apiKey: 'private-api-key', userId: 'stable-user-123',
    });
    expect(JSON.parse(serialized)).toEqual({ clientName: 'unclassified' });
  });

  it.each(['ChatGPT', 'openai-mcp', 'Claude Desktop', 'claude-ai', 'transit-prompt-evals'])('keeps explicit client category %s', clientName => {
    expect(JSON.parse(serializeTelemetry({ clientName }))).toEqual({ clientName });
  });
});
