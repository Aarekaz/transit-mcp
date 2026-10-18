import { describe, expect, it } from 'vitest';

const wireCheck = (id: string, status = 'SUCCESS', fields = {}) => ({
  id, status, name: 'Protocol check', description: 'Public protocol requirement',
  timestamp: '2026-10-18T00:00:00.000Z', specReferences: [{ id: 'MCP', url: 'https://modelcontextprotocol.io' }], ...fields,
});

describe('frozen product conformance classification', () => {
  it('requires exact diagnostic identity and error plus passing mapped evidence; leaves the raw result failed', async () => {
    const module = await import('../../scripts/run-conformance.mjs');
    expect(module).toHaveProperty('scoreProductConformance');
    const profile = { requiredChecks: { 'tools-call-image': [{ id: 'tools-call-image', statuses: ['FAILURE'] }] },
      evidence: { real: { file: 'tests/real.test.ts', title: 'actual wire behavior' } },
      diagnosticChecks: [{ scenario: 'tools-call-image', id: 'tools-call-image', error: 'Failed: Tool test_image_content not found', evidence: ['real'] }] };
    const checks = [wireCheck('tools-call-image', 'FAILURE', { scenario: 'tools-call-image', errorMessage: 'Failed: Tool test_image_content not found' })];
    const evidence = [{ file: 'tests/real.test.ts', title: 'actual wire behavior', status: 'passed' }];
    const result = module.scoreProductConformance(profile, checks, evidence);
    expect(result).toMatchObject({ passed: true, diagnosticFailures: 1, unclassifiedFailures: [], missingEvidence: [] });
    expect(checks[0]!.status).toBe('FAILURE');
    for (const mutated of [
      [{ ...checks[0], id: 'new-check' }],
      [{ ...checks[0], errorMessage: 'wire-schema regression' }],
      [{ ...checks[0], scenario: 'server-stateless' }],
      [...checks, { scenario: 'tools-list', id: 'tools-list', status: 'FAILURE', errorMessage: 'invalid schema' }],
      [...checks, { scenario: 'tools-list', id: 'tools-list', status: 'SKIPPED' }],
      [...checks, { scenario: 'tools-list', id: 'tools-list', status: 'UNKNOWN' }],
    ]) expect(module.scoreProductConformance(profile, mutated, evidence).passed).toBe(false);
    for (const missing of [[], [{ ...evidence[0], status: 'skipped' }], [{ ...evidence[0], title: 'renamed test' }]]) {
      expect(module.scoreProductConformance(profile, checks, missing).passed).toBe(false);
    }
  });

  it('rejects deleted, identity-less, duplicate and truncated required records instead of accepting the retained successes', async () => {
    const { scoreProductConformance } = await import('../../scripts/run-conformance.mjs');
    const profile = { evidence: {}, diagnosticChecks: [], requiredChecks: {
      'server-stateless': [
        { id: 'sep-2575-server-implements-discover', statuses: ['SUCCESS', 'FAILURE'] },
        { id: 'sep-2575-missing-capability-http-400', statuses: ['SUCCESS', 'FAILURE'] },
      ], 'tools-list': [{ id: 'tools-list', statuses: ['SUCCESS', 'FAILURE'] }],
    } };
    const checks = [
      wireCheck('sep-2575-server-implements-discover', 'SUCCESS', { scenario: 'server-stateless' }),
      wireCheck('sep-2575-missing-capability-http-400', 'SUCCESS', { scenario: 'server-stateless' }),
      wireCheck('tools-list', 'SUCCESS', { scenario: 'tools-list' }),
    ];
    expect(scoreProductConformance(profile, checks, []).passed).toBe(true);
    for (const mutation of [
      [checks[0], checks[2]],
      [checks[0], { scenario: 'server-stateless', status: 'SUCCESS' }, checks[2]],
      [...checks, checks[1]],
      checks.slice(0, 2),
      [...checks.slice(0, 2), { ...checks[2], name: undefined }],
      [...checks.slice(0, 2), { ...checks[2], timestamp: 'invalid' }],
      [...checks.slice(0, 2), { ...checks[2], timestamp: '2026' }],
      [...checks.slice(0, 2), { ...checks[2], specReferences: null }],
      [...checks.slice(0, 2), { ...checks[2], status: 'WARNING' }],
    ]) expect(scoreProductConformance(profile, mutation, []).passed).toBe(false);
  });

  it('distinguishes the three legitimate duplicate HTTP-check IDs by fieldIssue and rejects a duplicated case', async () => {
    const { scoreProductConformance } = await import('../../scripts/run-conformance.mjs');
    const cases = ['missing-meta', 'missing-protocol-version', 'missing-client-capabilities'];
    const profile = { evidence: {}, diagnosticChecks: [], requiredChecks: { 'server-stateless': cases.map(fieldIssue => ({
      id: 'sep-2575-http-server-meta-invalid-400', fieldIssue, statuses: ['SUCCESS', 'FAILURE'],
    })) } };
    const checks = cases.map(fieldIssue => wireCheck('sep-2575-http-server-meta-invalid-400', 'SUCCESS', { scenario: 'server-stateless', details: { fieldIssue } }));
    expect(scoreProductConformance(profile, checks, []).passed).toBe(true);
    expect(scoreProductConformance(profile, [checks[0], checks[0], checks[2]], []).passed).toBe(false);
    expect(scoreProductConformance(profile, checks.map(c => ({ ...c, details: undefined })), []).passed).toBe(false);
  });

  it('does not accept a successful conditional prerequisite without its newly required follow-up checks', async () => {
    const { scoreProductConformance } = await import('../../scripts/run-conformance.mjs');
    const profile = { evidence: {}, diagnosticChecks: [{ scenario: 'input-required-result-multi-round', id: 'sep-2322-multi-round-r1', error: 'Expected InputRequiredResult with inputRequests and requestState', evidence: ['real'] }],
      requiredChecks: { 'input-required-result-multi-round': [{ id: 'sep-2322-multi-round-r1', statuses: ['FAILURE'] }] } };
    const successWithoutFollowups = [wireCheck('sep-2322-multi-round-r1', 'SUCCESS', { scenario: 'input-required-result-multi-round' })];
    expect(scoreProductConformance(profile, successWithoutFollowups, []).passed).toBe(false);
  });
});
