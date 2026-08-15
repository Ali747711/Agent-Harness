import { describe, expect, it } from 'vitest';

import type { ModelStreamEvent } from '../types.ts';
import { createAnthropicModelClient } from './client.ts';

/**
 * Live smoke test (plan §6 layer 9). Excluded from the default run; execute
 * with `bun run test:live`. Requires ANTHROPIC_API_KEY.
 */
describe.skipIf(process.env.ANTHROPIC_API_KEY === undefined)('anthropic live smoke', () => {
  it('streams a one-shot answer end to end', async () => {
    const client = createAnthropicModelClient();
    const events: ModelStreamEvent[] = [];
    for await (const event of client.stream(
      {
        model: 'claude-opus-5',
        effort: 'low',
        thinking: 'adaptive',
        maxTokens: 2048,
        system: [{ text: 'Answer with a single word.', cache: false }],
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: ok' }] }]
      },
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(events[0]?.type).toBe('message_start');
    const stop = events.at(-1);
    expect(stop?.type).toBe('message_stop');
    if (stop?.type === 'message_stop') {
      expect(stop.stopReason).toBe('end_turn');
      expect(stop.usage.outputTokens).toBeGreaterThan(0);
      const text = stop.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      expect(text.toLowerCase()).toContain('ok');
    }
  }, 120_000);
});
