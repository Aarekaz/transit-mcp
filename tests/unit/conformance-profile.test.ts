import { describe, expect, it } from 'vitest';

describe('frozen product conformance classification', () => {
  it('requires exact diagnostic identity and error plus passing mapped evidence; leaves the raw result failed', async () => {
    const module = await import('../../scripts/run-conformance.mjs');
    expect(module).toHaveProperty('scoreProductConformance');
    const profile = { evidence: { real: { file: 'tests/real.test.ts', title: 'actual wire behavior' } },
      diagnosticChecks: [{ scenario: 'tools-call-image', id: 'tools-call-image', error: 'Failed: Tool test_image_content not found', evidence: ['real'] }] };
    const checks = [{ scenario: 'tools-call-image', id: 'tools-call-image', status: 'FAILURE', errorMessage: 'Failed: Tool test_image_content not found' }];
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
});
