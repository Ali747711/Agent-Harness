import type { AgentEvent, PermissionEffect } from '@harness/core';

/**
 * Pure AgentEvent[] → ViewModel reducer (PHASE1-PLAN §4.6 / step 13). No Ink,
 * no React, no I/O — this is where the TUI's test coverage lives, so the Ink
 * components stay dumb enough to need only smoke assertions.
 */
export interface ToolLine {
  callId: string;
  tool: string;
  title: string;
  status: 'running' | 'ok' | 'error';
  summary: string;
  durationMs: number;
  /** Tail of streamed output, capped so a chatty command cannot grow forever. */
  progress: string;
}

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; line: ToolLine }
  | { kind: 'error'; id: string; severity: string; code: string; message: string }
  | { kind: 'notice'; id: string; text: string };

export interface PendingPermission {
  requestId: string;
  title: string;
  tool: string;
  effects: PermissionEffect[];
  suggestions: string[];
}

export interface ViewModel {
  sessionId: string | null;
  model: string;
  workspaceRoot: string;
  memoryFiles: string[];
  status: 'starting' | 'idle' | 'working' | 'awaiting-permission';
  turn: number;
  transcript: TranscriptItem[];
  liveText: string;
  liveThinking: string;
  activeTools: ToolLine[];
  pendingPermission: PendingPermission | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    costUsd: number;
  };
  queued: string[];
}

const PROGRESS_CAP = 800;

export function initialViewModel(model: string, workspaceRoot: string): ViewModel {
  return {
    sessionId: null,
    model,
    workspaceRoot,
    memoryFiles: [],
    status: 'starting',
    turn: 0,
    transcript: [],
    liveText: '',
    liveThinking: '',
    activeTools: [],
    pendingPermission: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: 0 },
    queued: []
  };
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function tail(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(text.length - cap);
}

/** Move any streamed text into the transcript so <Static> can own it. */
function flushLive(vm: ViewModel): ViewModel {
  if (vm.liveThinking === '' && vm.liveText === '') {
    return vm;
  }
  const items: TranscriptItem[] = [...vm.transcript];
  if (vm.liveThinking !== '') {
    items.push({ kind: 'thinking', id: nextId('think'), text: vm.liveThinking });
  }
  if (vm.liveText !== '') {
    items.push({ kind: 'assistant', id: nextId('text'), text: vm.liveText });
  }
  return { ...vm, transcript: items, liveText: '', liveThinking: '' };
}

export function withUserPrompt(vm: ViewModel, text: string): ViewModel {
  return {
    ...vm,
    transcript: [...vm.transcript, { kind: 'user', id: nextId('user'), text }]
  };
}

export function withQueued(vm: ViewModel, queued: string[]): ViewModel {
  return { ...vm, queued };
}

export function withNotice(vm: ViewModel, text: string): ViewModel {
  return {
    ...vm,
    transcript: [...vm.transcript, { kind: 'notice', id: nextId('notice'), text }]
  };
}

export function reduce(vm: ViewModel, event: AgentEvent): ViewModel {
  switch (event.type) {
    case 'session_started':
      return {
        ...vm,
        sessionId: event.sessionId,
        model: event.model,
        workspaceRoot: event.workspaceRoot,
        memoryFiles: event.memoryFiles,
        status: 'idle'
      };

    case 'turn_started':
      return { ...vm, turn: event.turn, status: 'working', liveText: '', liveThinking: '' };

    case 'assistant_text_delta':
      return { ...vm, status: 'working', liveText: vm.liveText + event.text };

    case 'assistant_thinking_delta':
      return { ...vm, status: 'working', liveThinking: vm.liveThinking + event.text };

    case 'tool_call_started': {
      // Text streamed before a tool call belongs above it in the transcript.
      const flushed = flushLive(vm);
      return {
        ...flushed,
        status: 'working',
        activeTools: [
          ...flushed.activeTools,
          {
            callId: event.callId,
            tool: event.tool,
            title: event.title,
            status: 'running',
            summary: '',
            durationMs: 0,
            progress: ''
          }
        ]
      };
    }

    case 'tool_call_progress':
      return {
        ...vm,
        activeTools: vm.activeTools.map((line) =>
          line.callId === event.callId
            ? { ...line, progress: tail(line.progress + event.chunk, PROGRESS_CAP) }
            : line
        )
      };

    case 'tool_call_completed': {
      const finished = vm.activeTools.find((line) => line.callId === event.callId);
      const line: ToolLine = {
        callId: event.callId,
        tool: finished?.tool ?? 'tool',
        title: finished?.title ?? event.callId,
        status: event.ok ? 'ok' : 'error',
        summary: event.summary,
        durationMs: event.durationMs,
        progress: finished?.progress ?? ''
      };
      return {
        ...vm,
        activeTools: vm.activeTools.filter((active) => active.callId !== event.callId),
        transcript: [...vm.transcript, { kind: 'tool', id: nextId('tool'), line }]
      };
    }

    case 'permission_requested':
      return {
        ...flushLive(vm),
        status: 'awaiting-permission',
        pendingPermission: {
          requestId: event.requestId,
          title: event.request.title,
          tool: event.request.tool,
          effects: event.request.effects,
          suggestions: event.suggestions
        }
      };

    case 'permission_resolved': {
      const label =
        event.choice === 'deny'
          ? 'denied'
          : event.choice === 'allow_session'
            ? 'allowed for this session'
            : 'allowed once';
      return {
        ...vm,
        status: 'working',
        pendingPermission: null,
        transcript: [
          ...vm.transcript,
          { kind: 'notice', id: nextId('perm'), text: `permission ${label}` }
        ]
      };
    }

    case 'turn_completed': {
      const flushed = flushLive(vm);
      return {
        ...flushed,
        status: 'idle',
        usage: {
          inputTokens: flushed.usage.inputTokens + event.usage.inputTokens,
          outputTokens: flushed.usage.outputTokens + event.usage.outputTokens,
          cacheReadInputTokens:
            flushed.usage.cacheReadInputTokens + event.usage.cacheReadInputTokens,
          costUsd: flushed.usage.costUsd + event.costUsd
        }
      };
    }

    case 'error': {
      const flushed = flushLive(vm);
      return {
        ...flushed,
        transcript: [
          ...flushed.transcript,
          {
            kind: 'error',
            id: nextId('err'),
            severity: event.severity,
            code: event.code,
            message: event.message
          }
        ]
      };
    }

    case 'session_idle':
      // Idle means nothing is outstanding. An interrupt can beat a permission
      // response to the loop, so no permission_resolved arrives — without this
      // the dialog would stay on screen with nothing behind it.
      return {
        ...flushLive(vm),
        status: 'idle',
        activeTools: [],
        pendingPermission: null
      };

    default: {
      const exhaustive: never = event;
      throw new Error(`unhandled event: ${JSON.stringify(exhaustive)}`);
    }
  }
}
