import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isHarnessError } from '../../errors/index.ts';
import type { ModelStreamEvent } from '../types.ts';
import { transformMessageStream } from './transform.ts';

const CASSETTES = new URL('../../../../../fixtures/cassettes/', import.meta.url);

function cassette(name: string): unknown[] {
  const raw = readFileSync(new URL(name, CASSETTES), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function* replay(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event;
    await Promise.resolve();
  }
}

async function collect(events: unknown[]): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const event of transformMessageStream(replay(events))) {
    out.push(event);
  }
  return out;
}

describe('transformMessageStream (cassette replay)', () => {
  it('normalizes a plain text turn with merged usage', async () => {
    const events = await collect(cassette('text-turn.jsonl'));
    expect(events).toEqual([
      { type: 'message_start', model: 'claude-opus-5' },
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world' },
      {
        type: 'message_stop',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 42,
          outputTokens: 12,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 12
        },
        content: [{ type: 'text', text: 'Hello world' }]
      }
    ]);
  });

  it('accumulates thinking signatures and split tool-use JSON', async () => {
    const events = await collect(cassette('tool-use-turn.jsonl'));
    const stop = events.at(-1);
    expect(stop).toEqual({
      type: 'message_stop',
      stopReason: 'tool_use',
      usage: {
        inputTokens: 210,
        outputTokens: 58,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 180
      },
      content: [
        { type: 'thinking', thinking: 'I should read the file first.', signature: 'sig-abc' },
        { type: 'text', text: 'Reading the file now.' },
        { type: 'tool_use', id: 'toolu_01', name: 'read', input: { path: 'src/index.ts' } }
      ]
    });
    expect(events).toContainEqual({ type: 'tool_use_start', id: 'toolu_01', name: 'read' });
    expect(
      events.filter((event) => event.type === 'tool_use_input_delta').map((e) => e.partialJson)
    ).toEqual(['{"pa', 'th": "src/ind', 'ex.ts"}']);
  });

  it('handles a pre-output refusal (empty content)', async () => {
    const events = await collect(cassette('refusal.jsonl'));
    expect(events).toEqual([
      { type: 'message_start', model: 'claude-opus-5' },
      {
        type: 'message_stop',
        stopReason: 'refusal',
        usage: {
          inputTokens: 18,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        },
        content: []
      }
    ]);
  });

  it('skips unknown event, block, and delta types without corrupting content', async () => {
    const events = await collect(cassette('unknown-events.jsonl'));
    const stop = events.at(-1);
    expect(stop?.type).toBe('message_stop');
    if (stop?.type === 'message_stop') {
      expect(stop.content).toEqual([{ type: 'text', text: 'ok' }]);
      expect(stop.stopReason).toBe('end_turn');
    }
  });

  it('throws a typed violation on malformed tool JSON', async () => {
    const events = cassette('tool-use-turn.jsonl').map((event) => {
      const cloned = JSON.parse(JSON.stringify(event)) as {
        type: string;
        index?: number;
        delta?: { type: string; partial_json?: string };
      };
      if (cloned.type === 'content_block_delta' && cloned.delta?.type === 'input_json_delta') {
        cloned.delta.partial_json = '{not-json';
      }
      return cloned;
    });
    // Deduplicate the three split deltas into one broken chunk is unnecessary —
    // three copies of '{not-json' are still malformed JSON.
    await expect(collect(events)).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.code === 'model_request_failed'
    );
  });

  it('throws when the stream ends without message_stop', async () => {
    const events = cassette('text-turn.jsonl').slice(0, -1);
    await expect(collect(events)).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.message.includes('without message_stop')
    );
  });

  it('throws on a missing stop_reason', async () => {
    const events = cassette('text-turn.jsonl').filter(
      (event) => (event as { type: string }).type !== 'message_delta'
    );
    await expect(collect(events)).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.message.includes('stop_reason')
    );
  });
});
