/**
 * Vitest Configuration
 * 
 * WHY VITEST:
 * - Modern test runner with great developer experience
 * - Native TypeScript and ESM support
 * - Compatible with Cloudflare Workers runtime
 * - Fast parallel execution
 * - Built-in coverage reporting
 * 
 * ALTERNATIVE CONSIDERED:
 * Jest: More mature but slower and requires complex setup for ESM
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test file patterns
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.wrangler'],

    // Coverage configuration
    coverage: {
      // WHY V8:
      // - Accurate source-level coverage
      // - Fast instrumentation
      // - Works well with TypeScript
      provider: 'v8',
      
      // Include all source files in coverage
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/types.ts',  // Type definitions don't need coverage
        'src/index.ts',  // Entry point, tested via integration tests
      ],

      // Coverage thresholds
      // WHY THESE NUMBERS:
      // - 60% is achievable with current test suite
      // - Gradually increase as more tests are added
      // - Critical modules (auth, validation) should be 100%
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },

      // Output formats
      reporter: ['text', 'json', 'html'],
      
      // Report uncovered lines
      reportOnFailure: true,
    },

    // Test environment
    // WHY NODE:
    // Cloudflare Workers use V8 isolates, similar to Node.js
    // We mock Workers-specific APIs (KV, etc.)
    environment: 'node',

    // Global test timeout
    testTimeout: 10000,  // 10 seconds

    // Retry flaky tests
    retry: 0,  // Don't retry, fix flaky tests instead

    // Reporter
    reporters: ['verbose'],

    // Mock reset behavior
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
});
