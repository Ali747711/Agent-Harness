import { describe, expect, it } from 'vitest';

import { CONFIG_DEFAULTS, type Config } from '../config/index.ts';
import { MockModelClient, type ScriptedTurn } from '../model/mock/client.ts';
import type { AgentEvent } from '../protocol/events.ts';
import { PROTOCOL_VERSION } from '../protocol/types.ts';
import { AgentSession } from './session.ts';

function makeSession(
  turns: ScriptedTurn[],
  configOverrides: Partial<Config> = {}
): { session: AgentSession; client: MockModelClient } {
  const client = new MockModelClient(turns);
  const session = new AgentSession({
    config: { ...CONFIG_DEFAULTS, ...configOverrides },
    modelClient: client,
    workspaceRoot: '/work/repo',
    sessionId: 'sess-test',
    retry: { attempts: 3, baseDelayMs: 1 }
  });
  return { session, client };
}

async function collect(
  session: AgentSession,
  prompt: string,
  signal: AbortSignal = new AbortController().signal
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.run(prompt, signal)) {
    events.push(event);
  }
  return events;
}

describe('AgentSession loop v0', () => {
  it('reports context as the last request only, not the turn total', async () => {
    // A turn with a tool call makes two requests, each re-sending the whole
    // history. Summing them made "% ctx" read ~2x the real context and look
    // like runaway growth on a conversation that had barely grown.
    const { session } = makeSession([
      { toolCalls: [{ name: 'read', input: { path: 'a.ts' } }] },
      { text: 'done' }
    ]);
    const events = await collect(session, 'go');
    const completed = events.find((event) => event.type === 'turn_completed');

    expect(completed).toBeDefined();
    if (completed?.type !== 'turn_completed') {
      throw new Error('expected turn_completed');
    }
    // The mock bills 100 input per request; two requests were made.
    expect(completed.usage.inputTokens).toBe(200);
    expect(completed.contextTokens).toBe(100);
  });

  it('emits the golden one-shot sequence', async () => {
    const { session } = makeSession([{ text: 'short answer' }]);
    const events = await collect(session, 'say something short');
    expect(events).toEqual([
      {
        type: 'session_started',
        sessionId: 'sess-test',
        protocolVersion: PROTOCOL_VERSION,
        model: 'claude-opus-5',
        workspaceRoot: '/work/repo',
        memoryFiles: []
      },
      { type: 'turn_started', turn: 1 },
      { type: 'assistant_text_delta', text: 'short answer' },
      {
        type: 'turn_completed',
        stopReason: 'end_turn',
        // One request in this turn, so the context reading equals its prompt.
        // On a multi-tool turn it stays the LAST request's size while `usage`
        // keeps summing every request.
        contextTokens: 100,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        },
        costUsd: (100 * 5 + 20 * 25) / 1_000_000
      },
      { type: 'session_idle' }
    ]);
  });

  it('keeps history across turns and emits session_started once', async () => {
    const { session, client } = makeSession([{ text: 'first' }, { text: 'second' }]);
    await collect(session, 'one');
    const events = await collect(session, 'two');

    expect(events.some((event) => event.type === 'session_started')).toBe(false);
    expect(events[0]).toEqual({ type: 'turn_started', turn: 2 });
    expect(client.requests).toHaveLength(2);
    // Second request carries: user, assistant, user.
    expect(client.requests[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user'
    ]);
    // Rolling tail cache breakpoint points at the last message (ADR-0008).
    expect(client.requests[1]?.cacheBreakpoints).toEqual([2]);
  });

  it('forwards thinking deltas', async () => {
    const { session } = makeSession([{ thinking: 'pondering', text: 'done' }]);
    const events = await collect(session, 'think about it');
    expect(events).toContainEqual({ type: 'assistant_thinking_delta', text: 'pondering' });
  });

  it('continues through pause_turn and sums usage into one turn_completed', async () => {
    const { session, client } = makeSession([
      { text: 'part one. ', stopReason: 'pause_turn' },
      { text: 'part two.' }
    ]);
    const events = await collect(session, 'long task');

    expect(client.requests).toHaveLength(2);
    const completions = events.filter((event) => event.type === 'turn_completed');
    expect(completions).toHaveLength(1);
    expect(completions[0]?.stopReason).toBe('end_turn');
    expect(completions[0]?.usage.outputTokens).toBe(40); // 20 + 20
    // Paused assistant content was appended before the follow-up request.
    expect(client.requests[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant'
    ]);
  });

  it.each([
    ['refusal', 'refusal', false],
    ['max_tokens', 'max_tokens', true],
    ['model_context_window_exceeded', 'context_window_exceeded', false]
  ] as const)('surfaces %s with a legible error event', async (stopReason, code, recoverable) => {
    const { session } = makeSession([{ text: 'x', stopReason }]);
    const events = await collect(session, 'go');
    const completion = events.find((event) => event.type === 'turn_completed');
    expect(completion?.stopReason).toBe(stopReason);
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({ code, recoverable, severity: 'error' });
    expect(events.at(-1)).toEqual({ type: 'session_idle' });
  });

  it('feeds unknown-tool errors back as tool_results and continues the loop', async () => {
    const { session, client } = makeSession([
      { toolCalls: [{ name: 'read', input: { path: 'a' } }] },
      { text: 'recovered without tools' }
    ]);
    const events = await collect(session, 'read something');

    expect(client.requests).toHaveLength(2);
    const followUp = client.requests[1]?.messages.at(-1);
    expect(followUp?.role).toBe('user');
    const block = followUp?.role === 'user' ? followUp.content[0] : undefined;
    expect(block).toMatchObject({
      type: 'tool_result',
      toolUseId: 'mock-call-1',
      isError: true
    });
    if (block?.type === 'tool_result') {
      expect(block.content).toContain('unknown tool: read');
    }
    expect(events.find((event) => event.type === 'tool_call_completed')).toMatchObject({
      ok: false
    });
    expect(events.find((event) => event.type === 'turn_completed')?.stopReason).toBe('end_turn');
  });

  it('retries recoverable pre-start failures with a warning event', async () => {
    const { session, client } = makeSession([
      { failBeforeStart: { recoverable: true, message: 'rate limited' } },
      { text: 'recovered' }
    ]);
    const events = await collect(session, 'go');

    expect(client.requests).toHaveLength(2);
    expect(events).toContainEqual({
      type: 'error',
      severity: 'warning',
      code: 'model_request_failed',
      message: expect.stringContaining('retrying (1/3)') as string,
      recoverable: true
    });
    expect(events.find((event) => event.type === 'turn_completed')?.stopReason).toBe('end_turn');
  });

  it('does not retry non-recoverable failures', async () => {
    const { session, client } = makeSession([
      { failBeforeStart: { recoverable: false, message: 'invalid request' } }
    ]);
    const events = await collect(session, 'go');
    expect(client.requests).toHaveLength(1);
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      severity: 'fatal',
      code: 'model_request_failed',
      recoverable: false
    });
    expect(events.at(-1)).toEqual({ type: 'session_idle' });
  });

  it('gives up after configured retry attempts', async () => {
    const { session, client } = makeSession(
      [
        { failBeforeStart: { recoverable: true } },
        { failBeforeStart: { recoverable: true } },
        { text: 'never reached' }
      ],
      {}
    );
    // Override retry to a single attempt.
    const single = new AgentSession({
      config: { ...CONFIG_DEFAULTS },
      modelClient: client,
      workspaceRoot: '/work/repo',
      retry: { attempts: 1, baseDelayMs: 1 }
    });
    const events = await collect(single, 'go');
    expect(client.requests).toHaveLength(2);
    expect(
      events.find((event) => event.type === 'error' && event.severity === 'fatal')
    ).toBeDefined();
    void session;
  });

  it('stops quietly on abort and stays resumable', async () => {
    const controller = new AbortController();
    controller.abort();
    const { session, client } = makeSession([{ text: 'never' }, { text: 'after resume' }]);
    const events = await collect(session, 'go', controller.signal);

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'turn_started',
      'session_idle'
    ]);
    expect(events.some((event) => event.type === 'error')).toBe(false);

    // Session remains usable with a fresh signal (R7).
    const resumed = await collect(session, 'again');
    expect(resumed.find((event) => event.type === 'turn_completed')).toBeDefined();
    void client;
  });

  it('enforces the maxTurns request guard', async () => {
    const { session, client } = makeSession(
      [
        { text: 'looping. ', stopReason: 'pause_turn' },
        { text: 'still looping. ', stopReason: 'pause_turn' }
      ],
      { maxTurns: 1 }
    );
    const events = await collect(session, 'go');
    expect(client.requests).toHaveLength(1);
    expect(events.find((event) => event.type === 'error')).toMatchObject({ code: 'max_turns' });
  });
});
