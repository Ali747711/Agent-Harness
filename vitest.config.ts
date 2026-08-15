import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Live-API tests are tagged and excluded from the default run (plan §6 layer 9).
    exclude: ['**/node_modules/**', '**/*.live.test.ts']
  }
});
