import { describe, expect, it } from 'vitest';

import { serializeTelemetry } from '../../src/telemetry';

describe('serializeTelemetry', () => {
  it('serializes only the documented safe fields', () => {
    const serialized = serializeTelemetry({
      correlationId: 'req-123',
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
      correlationId: 'req-123',
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
