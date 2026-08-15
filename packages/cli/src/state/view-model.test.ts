import type { AgentEvent } from '@harness/core';
import { describe, expect, it } from 'vitest';

import {
  initialViewModel,
  reduce,
  type ViewModel,
  withNotice,
  withUserPrompt
} from './view-model.ts';

function fresh(): ViewModel {
  return initialViewModel('claude-opus-5', '/work/repo');
}

function apply(vm: ViewModel, events: AgentEvent[]): ViewModel {
  return events.reduce(reduce, vm);
}

const started: AgentEvent = {
  type: 'session_started',
  sessionId: 'sess-1',
  protocolVersion: 1,
  model: 'claude-opus-5',
  workspaceRoot: '/work/repo',
  memoryFiles: ['CLAUDE.md']
};

const completed: AgentEvent = {
  type: 'turn_completed',
  stopReason: 'end_turn',
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 80,
    cacheCreationInputTokens: 0
  },
  costUsd: 0.001
};

describe('view-model reducer', () => {
  it('starts in `starting` and becomes idle once the session starts', () => {
    expect(fresh().status).toBe('starting');
    const vm = reduce(fresh(), started);
    expect(vm).toMatchObject({ status: 'idle', sessionId: 'sess-1', memoryFiles: ['CLAUDE.md'] });
  });

  it('accumulates streamed text and flushes it to the transcript on completion', () => {
    const vm = apply(fresh(), [
      started,
      { type: 'turn_started', turn: 1 },
      { type: 'assistant_text_delta', text: 'Hello ' },
      { type: 'assistant_text_delta', text: 'world' }
    ]);
    expect(vm.liveText).toBe('Hello world');
    expect(vm.status).toBe('working');

    const done = reduce(vm, completed);
    expect(done.liveText).toBe('');
    expect(done.status).toBe('idle');
    expect(done.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hello world' });
    expect(done.usage).toMatchObject({ inputTokens: 100, cacheReadInputTokens: 80 });
  });

  it('keeps thinking separate from output', () => {
    const vm = apply(fresh(), [
      started,
      { type: 'turn_started', turn: 1 },
      { type: 'assistant_thinking_delta', text: 'considering' },
      { type: 'assistant_text_delta', text: 'answer' },
      completed
    ]);
    expect(vm.transcript.map((item) => item.kind)).toEqual(['thinking', 'assistant']);
  });

  it('tracks a tool call from start through progress to completion', () => {
    const running = apply(fresh(), [
      started,
      { type: 'turn_started', turn: 1 },
      {
        type: 'tool_call_started',
        callId: 'c1',
        tool: 'bash',
        title: 'run tests',
        input: { command: 'bun test' }
      },
      { type: 'tool_call_progress', callId: 'c1', chunk: 'PASS\n' }
    ]);
    expect(running.activeTools).toHaveLength(1);
    expect(running.activeTools[0]).toMatchObject({ status: 'running', progress: 'PASS\n' });

    const finished = reduce(running, {
      type: 'tool_call_completed',
      callId: 'c1',
      ok: true,
      summary: 'exit 0 in 900ms',
      durationMs: 900
    });
    expect(finished.activeTools).toEqual([]);
    expect(finished.transcript.at(-1)).toMatchObject({
      kind: 'tool',
      line: { status: 'ok', tool: 'bash', summary: 'exit 0 in 900ms' }
    });
  });

  it('flushes streamed text above a tool call so ordering reads correctly', () => {
    const vm = apply(fresh(), [
      started,
      { type: 'turn_started', turn: 1 },
      { type: 'assistant_text_delta', text: 'let me check' },
      {
        type: 'tool_call_started',
        callId: 'c1',
        tool: 'read',
        title: 'Read a.ts',
        input: { path: 'a.ts' }
      }
    ]);
    expect(vm.liveText).toBe('');
    expect(vm.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'let me check' });
  });

  it('caps tool progress so a chatty command cannot grow without bound', () => {
    let vm = apply(fresh(), [
      started,
      {
        type: 'tool_call_started',
        callId: 'c1',
        tool: 'bash',
        title: 'noisy',
        input: {}
      }
    ]);
    for (let i = 0; i < 200; i += 1) {
      vm = reduce(vm, { type: 'tool_call_progress', callId: 'c1', chunk: `line ${i}\n` });
    }
    const progress = vm.activeTools[0]?.progress ?? '';
    expect(progress.length).toBeLessThanOrEqual(800);
    // The TAIL is what matters — the newest output must survive.
    expect(progress).toContain('line 199');
  });

  it('ignores progress for an unknown call id', () => {
    const vm = reduce(reduce(fresh(), started), {
      type: 'tool_call_progress',
      callId: 'ghost',
      chunk: 'x'
    });
    expect(vm.activeTools).toEqual([]);
  });

  it('surfaces a permission request and clears it on resolution', () => {
    const asking = apply(fresh(), [
      started,
      { type: 'turn_started', turn: 1 },
      {
        type: 'permission_requested',
        requestId: 'p1',
        callId: 'c1',
        request: {
          tool: 'write',
          title: 'Write a.ts',
          effects: [{ kind: 'write', path: 'a.ts' }]
        },
        suggestions: ['write(a.ts)']
      }
    ]);
    expect(asking.status).toBe('awaiting-permission');
    expect(asking.pendingPermission).toMatchObject({ requestId: 'p1', tool: 'write' });

    const resolved = reduce(asking, {
      type: 'permission_resolved',
      requestId: 'p1',
      choice: 'allow_session',
      by: 'user'
    });
    expect(resolved.pendingPermission).toBeNull();
    expect(resolved.status).toBe('working');
    expect(resolved.transcript.at(-1)).toMatchObject({
      kind: 'notice',
      text: 'permission allowed for this session'
    });
  });

  it('records errors with severity and never loses buffered text', () => {
    const vm = apply(fresh(), [
      started,
      { type: 'turn_started', turn: 1 },
      { type: 'assistant_text_delta', text: 'partial' },
      {
        type: 'error',
        severity: 'error',
        code: 'refusal',
        message: 'declined',
        recoverable: false
      }
    ]);
    expect(vm.transcript.map((item) => item.kind)).toEqual(['assistant', 'error']);
    expect(vm.transcript.at(-1)).toMatchObject({ code: 'refusal', severity: 'error' });
  });

  it('clears in-flight tools when the session goes idle after an interrupt', () => {
    const vm = apply(fresh(), [
      started,
      {
        type: 'tool_call_started',
        callId: 'c1',
        tool: 'bash',
        title: 'sleep 30',
        input: {}
      },
      { type: 'session_idle' }
    ]);
    expect(vm.activeTools).toEqual([]);
    expect(vm.status).toBe('idle');
  });

  it('clears a pending permission on idle (interrupt can beat the response)', () => {
    const vm = apply(fresh(), [
      started,
      {
        type: 'permission_requested',
        requestId: 'p1',
        callId: 'c1',
        request: { tool: 'bash', title: 'rm -rf x', effects: [{ kind: 'execute', command: 'rm' }] },
        suggestions: []
      },
      { type: 'session_idle' }
    ]);
    expect(vm.pendingPermission).toBeNull();
    expect(vm.status).toBe('idle');
  });

  it('accumulates usage across turns', () => {
    const vm = apply(fresh(), [started, completed, completed]);
    expect(vm.usage.inputTokens).toBe(200);
    expect(vm.usage.costUsd).toBeCloseTo(0.002, 10);
  });

  it('supports local user prompts and notices', () => {
    const vm = withNotice(withUserPrompt(fresh(), 'do the thing'), 'interrupted');
    expect(vm.transcript.map((item) => item.kind)).toEqual(['user', 'notice']);
  });

  it('never mutates the previous state', () => {
    const before = reduce(fresh(), started);
    const snapshot = JSON.stringify(before);
    reduce(before, { type: 'assistant_text_delta', text: 'x' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
