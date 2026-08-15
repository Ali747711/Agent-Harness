import type { Usage } from '../protocol/types.ts';

/**
 * USD per million tokens (input/output). Cache read bills at ~0.1× input,
 * cache write (5m TTL) at ~1.25× input. `input_tokens` from the API is the
 * uncached remainder, so the components sum without double counting.
 * Unknown models cost 0 — accounting is best-effort, never a crash.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 }
};

const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

export function estimateCostUsd(model: string, usage: Usage): number {
  const price = PRICES_PER_MTOK[model];
  if (price === undefined) {
    return 0;
  }
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadInputTokens * price.input * CACHE_READ_FACTOR +
      usage.cacheCreationInputTokens * price.input * CACHE_WRITE_FACTOR) /
    1_000_000
  );
}
