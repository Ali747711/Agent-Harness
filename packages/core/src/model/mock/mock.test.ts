import { describe, expect, it } from 'vitest';

import { isHarnessError } from '../../errors/index.ts';
import { StopReasonSchema } from '../../protocol/index.ts';
import type { ModelRequest, ModelStreamEvent } from '../types.ts';
import { MockModelClient } from './client.ts';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-opus-5',
    effort: 'xhigh',
    thinking: 'adaptive',
    maxTokens: 32_000,
    system: [{ text: 'system prompt' }],
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides
  };
}

async function collect(
  client: MockModelClient,
  req: ModelRequest = request(),
  signal: AbortSignal = new AbortController().signal
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of client.stream(req, signal)) {
    events.push(event);
  }
  return events;
}

describe('MockModelClient', () => {
  it('emits a deterministic text turn', async () => {
    const client = new MockModelClient([{ text: 'short answer' }]);
    const events = await collect(client);
    expect(events).toEqual([
      { type: 'message_start', model: 'claude-opus-5' },
      { type: 'text_delta', text: 'short answer' },
      {
        type: 'message_stop',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        },
        content: [{ type: 'text', text: 'short answer' }]
      }
    ]);
  });

  it('chunks long text deterministically', async () => {
    const text = 'a'.repeat(60);
    const client = new MockModelClient([{ text }]);
    const events = await collect(client);
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.map((d) => d.text.length)).toEqual([24, 24, 12]);
    const stop = events.at(-1);
    if (stop?.type === 'message_stop') {
      expect(stop.content).toEqual([{ type: 'text', text }]);
    }
  });

  it('emits tool calls with thinking and defaults stopReason to tool_use', async () => {
    const client = new MockModelClient([
      {
        thinking: 'need the file',
        toolCalls: [{ name: 'read', input: { path: 'a.ts' } }]
      }
    ]);
    const events = await collect(client);
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'thinking_delta',
      'tool_use_start',
      'tool_use_input_delta',
      'tool_use_complete',
      'message_stop'
    ]);
    const stop = events.at(-1);
    if (stop?.type === 'message_stop') {
      expect(stop.stopReason).toBe('tool_use');
      expect(stop.content).toEqual([
        { type: 'thinking', thinking: 'need the file' },
        { type: 'tool_use', id: 'mock-call-1', name: 'read', input: { path: 'a.ts' } }
      ]);
    }
  });

  it('supports every stop reason via override', async () => {
    for (const stopReason of StopReasonSchema.options) {
      const client = new MockModelClient([{ text: 'x', stopReason }]);
      const events = await collect(client);
      const stop = events.at(-1);
      expect(stop?.type).toBe('message_stop');
      if (stop?.type === 'message_stop') {
        expect(stop.stopReason).toBe(stopReason);
      }
    }
  });

  it('injects pre-start failures with classification', async () => {
    const client = new MockModelClient([{ failBeforeStart: { recoverable: true } }]);
    try {
      await collect(client);
      expect.unreachable('should have thrown');
    } catch (error) {
      if (!isHarnessError(error)) {
        throw error;
      }
      expect(error.code).toBe('model_request_failed');
      expect(error.recoverable).toBe(true);
    }
  });

  it('injects mid-stream failures after N events', async () => {
    const client = new MockModelClient([{ text: 'a'.repeat(60), failAfterEvents: 2 }]);
    const seen: ModelStreamEvent[] = [];
    try {
      for await (const event of client.stream(request(), new AbortController().signal)) {
        seen.push(event);
      }
      expect.unreachable('should have thrown');
    } catch (error) {
      if (!isHarnessError(error)) {
        throw error;
      }
      expect(error.recoverable).toBe(true);
      expect(seen).toHaveLength(2);
    }
  });

  it('throws code aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new MockModelClient([{ text: 'never' }]);
    try {
      await collect(client, request(), controller.signal);
      expect.unreachable('should have thrown');
    } catch (error) {
      if (!isHarnessError(error)) {
        throw error;
      }
      expect(error.code).toBe('aborted');
    }
  });

  it('records requests for behavioral assertions', async () => {
    const client = new MockModelClient([{ text: 'ok' }]);
    const req = request({ system: [{ text: 'contains CLAUDE.md memory content' }] });
    await collect(client, req);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.system[0]?.text).toContain('CLAUDE.md');
  });

  it('throws internal when the script is exhausted', async () => {
    const client = new MockModelClient([]);
    await expect(collect(client)).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.code === 'internal'
    );
  });
});
