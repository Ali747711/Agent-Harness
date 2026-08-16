import { describe, expect, it } from 'vitest';

import { isHarnessError } from '../errors/index.ts';
import { type ClientCommand, type ClientCommandType, parseClientCommand } from './commands.ts';
import { type AgentEvent, type AgentEventType, parseAgentEvent } from './events.ts';
import { PROTOCOL_VERSION } from './types.ts';

/**
 * One sample per variant, keyed by type — TypeScript enforces completeness:
 * adding a protocol variant without a sample here is a compile error.
 */
const eventSamples: { [T in AgentEventType]: Extract<AgentEvent, { type: T }> } = {
  session_started: {
    type: 'session_started',
    sessionId: 'sess-01',
    protocolVersion: PROTOCOL_VERSION,
    model: 'claude-opus-5',
    workspaceRoot: '/work/repo',
    memoryFiles: ['AGENTS.md', 'CLAUDE.md']
  },
  turn_started: { type: 'turn_started', turn: 1 },
  assistant_text_delta: { type: 'assistant_text_delta', text: 'hello ' },
  assistant_thinking_delta: { type: 'assistant_thinking_delta', text: 'considering…' },
  tool_call_started: {
    type: 'tool_call_started',
    callId: 'call-1',
    tool: 'read',
    title: 'Read src/index.ts',
    input: { path: 'src/index.ts', nested: { limit: 100 } }
  },
  tool_call_progress: { type: 'tool_call_progress', callId: 'call-1', chunk: 'partial output\n' },
  tool_call_completed: {
    type: 'tool_call_completed',
    callId: 'call-1',
    ok: true,
    summary: 'read 120 lines',
    durationMs: 12
  },
  permission_requested: {
    type: 'permission_requested',
    requestId: 'perm-1',
    callId: 'call-2',
    request: {
      tool: 'bash',
      title: 'Run: git status',
      effects: [{ kind: 'execute', command: 'git status' }]
    },
    suggestions: ['allow Bash(git status:*) for this session']
  },
  permission_resolved: {
    type: 'permission_resolved',
    requestId: 'perm-1',
    choice: 'allow_session',
    by: 'user'
  },
  turn_completed: {
    type: 'turn_completed',
    stopReason: 'end_turn',
    contextTokens: 2100,
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 100
    },
    costUsd: 0.0135
  },
  error: {
    type: 'error',
    severity: 'error',
    code: 'model_request_failed',
    message: 'rate limited',
    recoverable: true
  },
  session_idle: { type: 'session_idle' }
};

const commandSamples: { [T in ClientCommandType]: Extract<ClientCommand, { type: T }> } = {
  prompt: { type: 'prompt', text: 'add a --version flag' },
  steer: { type: 'steer', text: 'actually use commander for that' },
  interrupt: { type: 'interrupt' },
  permission_response: { type: 'permission_response', requestId: 'perm-1', choice: 'deny' },
  shutdown: { type: 'shutdown' }
};

describe('AgentEvent protocol', () => {
  for (const [name, sample] of Object.entries(eventSamples)) {
    it(`${name} survives JSON round-trip and re-validates`, () => {
      const revived: unknown = JSON.parse(JSON.stringify(sample));
      expect(parseAgentEvent(revived)).toEqual(sample);
    });
  }

  it('rejects unknown event types', () => {
    expect(() => parseAgentEvent({ type: 'made_up' })).toThrowError();
  });

  it('rejects unknown keys (strict objects)', () => {
    const polluted = { ...eventSamples.session_idle, extra: 1 };
    expect(() => parseAgentEvent(polluted)).toThrowError();
  });

  it('rejects missing required fields with a typed error', () => {
    try {
      parseAgentEvent({ type: 'turn_started' });
      expect.unreachable('should have thrown');
    } catch (error) {
      if (!isHarnessError(error)) {
        throw error;
      }
      expect(error.code).toBe('protocol_invalid');
      expect(error.details).toBeDefined();
    }
  });
});

describe('ClientCommand protocol', () => {
  for (const [name, sample] of Object.entries(commandSamples)) {
    it(`${name} survives JSON round-trip and re-validates`, () => {
      const revived: unknown = JSON.parse(JSON.stringify(sample));
      expect(parseClientCommand(revived)).toEqual(sample);
    });
  }

  it('rejects empty prompt text', () => {
    expect(() => parseClientCommand({ type: 'prompt', text: '' })).toThrowError();
  });
});
