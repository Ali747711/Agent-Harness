import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_DEFAULTS,
  JsonlSessionStore,
  MockModelClient,
  parseAgentEvent
} from '@harness/core';
import { describe, expect, it } from 'vitest';

import { type HeadlessOptions, runHeadless } from './run.ts';

function options(overrides: Partial<HeadlessOptions> = {}): HeadlessOptions {
  return {
    prompt: 'say hi',
    format: 'text',
    config: { ...CONFIG_DEFAULTS },
    workspaceRoot: '/work/repo',
    signal: new AbortController().signal,
    // Default off so the suite never writes into the real ~/.harness;
    // transcript behavior is covered explicitly below.
    transcriptDir: null,
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

  it('warns loudly on stdout-free stderr when bypass mode is active (ADR-0006)', async () => {
    const out = sink();
    const err = sink();
    await runHeadless(options({ config: { ...CONFIG_DEFAULTS, permissionMode: 'bypass' } }), {
      modelClient: new MockModelClient([{ text: 'ok' }]),
      writeOut: out.write,
      writeErr: err.write
    });
    expect(err.text()).toContain('bypass');
    expect(err.text()).toContain('NOT confined to the workspace');
    // The warning must never pollute machine-readable stdout.
    expect(out.text()).not.toContain('WARNING');
  });

  it('does not warn in default mode', async () => {
    const err = sink();
    await runHeadless(options(), {
      modelClient: new MockModelClient([{ text: 'ok' }]),
      writeOut: sink().write,
      writeErr: err.write
    });
    expect(err.text()).toBe('');
  });

  it('writes a replayable JSONL transcript for every run (R5)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-headless-'));
    try {
      const code = await runHeadless(options({ transcriptDir: dir }), {
        modelClient: new MockModelClient([{ text: 'persisted' }]),
        writeOut: sink().write,
        writeErr: sink().write
      });
      expect(code).toBe(0);

      const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
      expect(files).toHaveLength(1);

      const sessionId = files[0]?.replace('.jsonl', '') ?? '';
      const store = new JsonlSessionStore(dir);
      const reopened = await store.open(sessionId);
      await reopened.sink.close();
      expect(reopened.entries.map((entry) => entry.type)).toEqual(['meta', 'user', 'assistant']);
      const assistant = reopened.entries[2];
      if (assistant?.type === 'assistant') {
        expect(assistant.data.content).toEqual([{ type: 'text', text: 'persisted' }]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('continues without a transcript when the directory cannot be created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-headless-'));
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    const err = sink();
    try {
      const code = await runHeadless(options({ transcriptDir: join(blocker, 'nested') }), {
        modelClient: new MockModelClient([{ text: 'still works' }]),
        writeOut: sink().write,
        writeErr: err.write
      });
      expect(code).toBe(0);
      expect(err.text()).toContain('no session transcript');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
