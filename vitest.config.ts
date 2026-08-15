import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Live-API tests are tagged and excluded from the default run (plan §6 layer 9).
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.live.test.ts',
        // Argument parsing and process wiring; its behavior is verified by
        // running the binary, which v8 coverage cannot see.
        'packages/cli/src/main.ts',
        // Test-only helper.
        'packages/core/src/testing/**'
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 78,
        branches: 68,
        // The security- and correctness-critical modules carry a higher bar
        // (PHASE1-PLAN §6).
        'packages/core/src/permissions/**': { lines: 85, statements: 85 },
        'packages/core/src/tools/**': { lines: 85, statements: 85 },
        'packages/core/src/agent/**': { lines: 85, statements: 85 },
        'packages/core/src/session/**': { lines: 85, statements: 85 }
      }
    }
  }
});
