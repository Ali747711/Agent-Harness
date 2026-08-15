import { defineConfig } from 'vitest/config';

/** Live-API suite: `bun run test:live`. Costs money; run deliberately. */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.live.test.ts'],
    environment: 'node'
  }
});
