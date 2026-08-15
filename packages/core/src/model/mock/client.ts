import { HarnessError } from '../../errors/index.ts';
import type { StopReason, Usage } from '../../protocol/index.ts';
import type { ModelClient } from '../client.ts';
import type {
  AssistantBlock,
  ModelCapabilities,
  ModelRequest,
  ModelStreamEvent
} from '../types.ts';

/**
 * Scripted ModelClient — the test workhorse (plan §6 layer 1). Deterministic:
 * fixed chunking, no timers, no randomness. Records every request for
 * behavioral assertions (e.g. "memory file content reached the request").
 */
export interface ScriptedToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ScriptedTurn {
  text?: string;
  thinking?: string;
  toolCalls?: ScriptedToolCall[];
  /** Defaults to 'tool_use' when toolCalls are present, else 'end_turn'. */
  stopReason?: StopReason;
  usage?: Partial<Usage>;
  /** Fault injection: throw before any event is emitted. */
  failBeforeStart?: { recoverable?: boolean; message?: string };
  /** Fault injection: throw after N events have been emitted. */
  failAfterEvents?: number;
}

const CHUNK_SIZE = 24;

const DEFAULT_USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0
};

function chunk(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    parts.push(text.slice(i, i + CHUNK_SIZE));
  }
  return parts.length > 0 ? parts : [];
}

function turnEvents(turn: ScriptedTurn, model: string): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [{ type: 'message_start', model }];
  const content: AssistantBlock[] = [];

  if (turn.thinking !== undefined) {
    for (const part of chunk(turn.thinking)) {
      events.push({ type: 'thinking_delta', text: part });
    }
    content.push({ type: 'thinking', thinking: turn.thinking });
  }
  if (turn.text !== undefined) {
    for (const part of chunk(turn.text)) {
      events.push({ type: 'text_delta', text: part });
    }
    content.push({ type: 'text', text: turn.text });
  }
  for (const [index, call] of (turn.toolCalls ?? []).entries()) {
    const id = call.id ?? `mock-call-${index + 1}`;
    events.push({ type: 'tool_use_start', id, name: call.name });
    events.push({
      type: 'tool_use_input_delta',
      id,
      partialJson: JSON.stringify(call.input)
    });
    events.push({ type: 'tool_use_complete', id, name: call.name, input: call.input });
    content.push({ type: 'tool_use', id, name: call.name, input: call.input });
  }

  const stopReason =
    turn.stopReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn');
  events.push({
    type: 'message_stop',
    stopReason,
    usage: { ...DEFAULT_USAGE, ...turn.usage },
    content
  });
  return events;
}

export class MockModelClient implements ModelClient {
  readonly provider = 'mock';
  readonly requests: ModelRequest[] = [];
  private readonly turns: ScriptedTurn[] = [];

  constructor(turns: ScriptedTurn[] = []) {
    this.turns.push(...turns);
  }

  /** Append turns to the script (fluent, chainable). */
  script(turns: ScriptedTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  capabilities(): ModelCapabilities {
    return {
      systemRoleMessages: true,
      adaptiveThinking: true,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      maxCacheBreakpoints: 4
    };
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new HarnessError('internal', 'MockModelClient: script exhausted');
    }
    if (turn.failBeforeStart !== undefined) {
      throw new HarnessError(
        'model_request_failed',
        turn.failBeforeStart.message ?? 'injected pre-start failure',
        { recoverable: turn.failBeforeStart.recoverable ?? true }
      );
    }

    let emitted = 0;
    for (const event of turnEvents(turn, request.model)) {
      if (signal.aborted) {
        throw new HarnessError('aborted', 'model request aborted', { cause: signal.reason });
      }
      if (turn.failAfterEvents !== undefined && emitted >= turn.failAfterEvents) {
        throw new HarnessError('model_request_failed', 'injected mid-stream failure', {
          recoverable: true
        });
      }
      yield event;
      emitted += 1;
      // Yield to the microtask queue so consumers exercise genuine async paths.
      await Promise.resolve();
    }
  }
}
