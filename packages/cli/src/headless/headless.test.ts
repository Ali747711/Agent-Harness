import { CONFIG_DEFAULTS, MockModelClient, parseAgentEvent } from '@harness/core';
import { describe, expect, it } from 'vitest';

import { type HeadlessOptions, runHeadless } from './run.ts';

function options(overrides: Partial<HeadlessOptions> = {}): HeadlessOptions {
  return {
    prompt: 'say hi',
    format: 'text',
    config: { ...CONFIG_DEFAULTS },
    workspaceRoot: '/work/repo',
    signal: new AbortController().signal,
    ...overrides
  };
}

function sink(): { chunks: string[]; write: (chunk: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk) => {
      chunks.push(chunk);
    },
    text: () => chunks.join('')
  };
}

describe('runHeadless', () => {
  it('jsonl: every line is a valid protocol event (serializability proof)', async () => {
    const out = sink();
    const code = await runHeadless(options({ format: 'jsonl' }), {
      modelClient: new MockModelClient([{ text: 'hello there' }]),
      writeOut: out.write,
      writeErr: sink().write
    });

    expect(code).toBe(0);
    const lines = out.text().trim().split('\n');
    const events = lines.map((line) => parseAgentEvent(JSON.parse(line)));
    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'turn_started',
      'assistant_text_delta',
      'turn_completed',
      'session_idle'
    ]);
  });

  it('json: emits one parseable array of events', async () => {
    const out = sink();
    const code = await runHeadless(options({ format: 'json' }), {
      modelClient: new MockModelClient([{ text: 'hi' }]),
      writeOut: out.write,
      writeErr: sink().write
    });
    expect(code).toBe(0);
    const events = (JSON.parse(out.text()) as unknown[]).map(parseAgentEvent);
    expect(events.at(-1)?.type).toBe('session_idle');
  });

  it('text: prints assistant text to stdout and nothing else', async () => {
    const out = sink();
    const err = sink();
    const code = await runHeadless(options({ format: 'text' }), {
      modelClient: new MockModelClient([{ text: 'plain answer' }]),
      writeOut: out.write,
      writeErr: err.write
    });
    expect(code).toBe(0);
    expect(out.text()).toBe('plain answer\n');
    expect(err.text()).toBe('');
  });

  it('text: routes errors to stderr and exits 1', async () => {
    const out = sink();
    const err = sink();
    const code = await runHeadless(options({ format: 'text' }), {
      modelClient: new MockModelClient([{ text: 'nope', stopReason: 'refusal' }]),
      writeOut: out.write,
      writeErr: err.write
    });
    expect(code).toBe(1);
    expect(err.text()).toContain('error (refusal)');
  });

  it('returns 130 when interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    const code = await runHeadless(options({ signal: controller.signal }), {
      modelClient: new MockModelClient([{ text: 'never' }]),
      writeOut: sink().write,
      writeErr: sink().write
    });
    expect(code).toBe(130);
  });

  it('retry warnings do not fail the run', async () => {
    const out = sink();
    const code = await runHeadless(options({ format: 'jsonl' }), {
      modelClient: new MockModelClient([
        { failBeforeStart: { recoverable: true } },
        { text: 'recovered' }
      ]),
      writeOut: out.write,
      writeErr: sink().write
    });
    expect(code).toBe(0);
    expect(out.text()).toContain('"severity":"warning"');
  });
});
