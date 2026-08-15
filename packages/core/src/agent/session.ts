import type { Config } from '../config/schema.ts';
import { HarnessError, isHarnessError } from '../errors/index.ts';
import type { ModelClient } from '../model/client.ts';
import { estimateCostUsd } from '../model/pricing.ts';
import type { AssistantBlock, ModelMessage, ModelRequest, SystemBlock } from '../model/types.ts';
import type { AgentEvent } from '../protocol/events.ts';
import { PROTOCOL_VERSION, type StopReason, type Usage } from '../protocol/types.ts';
import {
  makeEntry,
  resolvePath,
  type SessionEntry,
  type SessionSink,
  toModelMessages
} from '../session/index.ts';
import { sleep } from './sleep.ts';

/**
 * Agent loop v0 (PHASE1-PLAN.md step 4): no tools yet. Owns turn state,
 * exhaustive stop_reason handling, retry policy (the ModelClient never
 * retries), cancellation, and the maxTurns guard. Emits protocol events only —
 * never writes to stdout (ADR-0003).
 */
export interface AgentSessionOptions {
  config: Config;
  modelClient: ModelClient;
  workspaceRoot: string;
  sessionId?: string;
  /** Transcript sink (ADR-0004). Absent = ephemeral session (tests, one-offs). */
  sink?: SessionSink;
  retry?: {
    /** Max retries per model request after recoverable failures. Default 3. */
    attempts?: number;
    /** Base backoff delay; grows exponentially with jitter. Default 500ms. */
    baseDelayMs?: number;
  };
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0
};

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens
  };
}

/**
 * Minimal frozen system prompt. The full SystemPromptBuilder (identity, env
 * snapshot, project memory) lands in step 12 — the freeze discipline
 * (ADR-0008: byte-identical across turns) starts now.
 */
function buildSystemPromptV0(workspaceRoot: string): SystemBlock[] {
  return [
    {
      text: [
        'You are Harness, a coding agent that runs in a terminal.',
        'Be direct and concise. When asked about code, ground answers in the given context.',
        `Working directory: ${workspaceRoot}`
      ].join('\n'),
      cache: true
    }
  ];
}

interface TurnOutcome {
  stopReason: StopReason;
  content: AssistantBlock[];
  usage: Usage;
}

export class AgentSession {
  readonly sessionId: string;
  private readonly options: AgentSessionOptions;
  private readonly system: SystemBlock[];
  private history: ModelMessage[] = [];
  private turn = 0;
  private started = false;
  private lastEntryId: string | null = null;

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.system = buildSystemPromptV0(options.workspaceRoot);
  }

  /**
   * Resume from persisted entries (R5): seeds history from the resolved
   * root-agent path, restores turn count, and re-attaches the entry chain so
   * new entries parent onto the transcript's leaf.
   */
  static fromEntries(entries: readonly SessionEntry[], options: AgentSessionOptions): AgentSession {
    const meta = entries.find((entry) => entry.type === 'meta');
    const session = new AgentSession({
      ...options,
      ...(options.sessionId === undefined &&
        meta !== undefined && { sessionId: meta.data.sessionId })
    });
    const path = resolvePath(entries);
    session.history = toModelMessages(path);
    session.turn = path.filter((entry) => entry.type === 'user').length;
    session.lastEntryId = path.at(-1)?.id ?? null;
    return session;
  }

  /** Immutable view of the conversation (for tests and, later, the store). */
  get messages(): readonly ModelMessage[] {
    return this.history;
  }

  async *run(prompt: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const { config } = this.options;

    if (!this.started) {
      this.started = true;
      yield {
        type: 'session_started',
        sessionId: this.sessionId,
        protocolVersion: PROTOCOL_VERSION,
        model: config.model,
        workspaceRoot: this.options.workspaceRoot,
        memoryFiles: [] // loaded by the ContextPipeline from step 12
      };
    }

    this.history = [...this.history, { role: 'user', content: [{ type: 'text', text: prompt }] }];
    this.turn += 1;
    const persistError = await this.tryAppend({
      type: 'user',
      data: { content: [{ type: 'text', text: prompt }] }
    });
    if (persistError !== null) {
      yield this.fatal(persistError);
      yield { type: 'session_idle' };
      return;
    }
    yield { type: 'turn_started', turn: this.turn };

    let requestCount = 0;
    let turnUsage = ZERO_USAGE;

    while (true) {
      if (requestCount >= config.maxTurns) {
        yield {
          type: 'error',
          severity: 'error',
          code: 'max_turns',
          message: `stopped after ${config.maxTurns} model requests (maxTurns); raise --max-turns to continue`,
          recoverable: true
        };
        break;
      }
      requestCount += 1;

      let outcome: TurnOutcome;
      try {
        const streamed = yield* this.streamOnce(signal);
        outcome = streamed;
      } catch (error) {
        const classified = isHarnessError(error)
          ? error
          : new HarnessError('internal', `unexpected loop failure: ${String(error)}`, {
              cause: error
            });
        if (classified.code === 'aborted') {
          // User interrupt: quiet, resumable stop (R7).
          yield { type: 'session_idle' };
          return;
        }
        yield {
          type: 'error',
          severity: 'fatal',
          code: classified.code,
          message: classified.message,
          recoverable: classified.recoverable
        };
        break;
      }

      turnUsage = addUsage(turnUsage, outcome.usage);
      if (outcome.content.length > 0) {
        this.history = [...this.history, { role: 'assistant', content: outcome.content }];
        const assistantPersistError = await this.tryAppend({
          type: 'assistant',
          data: { content: outcome.content, stopReason: outcome.stopReason, usage: outcome.usage }
        });
        if (assistantPersistError !== null) {
          yield this.fatal(assistantPersistError);
          break;
        }
      }

      const stopReason = outcome.stopReason;
      switch (stopReason) {
        case 'pause_turn':
          // Server-side pause: re-send with the paused assistant turn appended.
          continue;
        case 'end_turn':
        case 'stop_sequence': {
          yield this.turnCompleted(stopReason, turnUsage);
          break;
        }
        case 'tool_use': {
          yield this.turnCompleted(stopReason, turnUsage);
          yield {
            type: 'error',
            severity: 'error',
            code: 'tools_unavailable',
            message: 'the model requested a tool, but tool execution lands in step 7',
            recoverable: false
          };
          break;
        }
        case 'max_tokens': {
          yield this.turnCompleted(stopReason, turnUsage);
          yield {
            type: 'error',
            severity: 'error',
            code: 'max_tokens',
            message: `output hit maxTokens (${config.maxTokens}); raise --max-tokens and retry`,
            recoverable: true
          };
          break;
        }
        case 'refusal': {
          yield this.turnCompleted(stopReason, turnUsage);
          yield {
            type: 'error',
            severity: 'error',
            code: 'refusal',
            message: 'the model declined this request (safety); rephrase or try a different task',
            recoverable: false
          };
          break;
        }
        case 'model_context_window_exceeded': {
          yield this.turnCompleted(stopReason, turnUsage);
          yield {
            type: 'error',
            severity: 'error',
            code: 'context_window_exceeded',
            message:
              'conversation exceeded the context window; compaction lands in phase 2 — start a new session',
            recoverable: false
          };
          break;
        }
        default: {
          const exhaustive: never = stopReason;
          throw new HarnessError('internal', `unhandled stop reason: ${String(exhaustive)}`);
        }
      }
      break;
    }

    if (this.options.sink !== undefined) {
      try {
        await this.options.sink.flush();
      } catch {
        yield {
          type: 'error',
          severity: 'warning',
          code: 'session_write_failed',
          message: 'transcript flush failed; recent entries may not be durable yet',
          recoverable: true
        };
      }
    }
    yield { type: 'session_idle' };
  }

  /** Append a transcript entry; failures are returned, never swallowed. */
  private async tryAppend(body: Parameters<typeof makeEntry>[1]): Promise<HarnessError | null> {
    const { sink } = this.options;
    if (sink === undefined) {
      return null;
    }
    const entry = makeEntry({ parentId: this.lastEntryId }, body);
    this.lastEntryId = entry.id;
    try {
      await sink.append(entry);
      return null;
    } catch (error) {
      return isHarnessError(error)
        ? error
        : new HarnessError('session_write_failed', `transcript append failed: ${String(error)}`, {
            cause: error
          });
    }
  }

  private fatal(error: HarnessError): AgentEvent {
    return {
      type: 'error',
      severity: 'fatal',
      code: error.code,
      message: error.message,
      recoverable: error.recoverable
    };
  }

  private turnCompleted(stopReason: StopReason, usage: Usage): AgentEvent {
    return {
      type: 'turn_completed',
      stopReason,
      usage,
      costUsd: estimateCostUsd(this.options.config.model, usage)
    };
  }

  /**
   * One model request with retry-on-recoverable (backoff + jitter, honoring
   * retryAfterMs). Yields protocol deltas; returns the accumulated outcome.
   */
  private async *streamOnce(
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, TurnOutcome, undefined> {
    const { config, modelClient, retry } = this.options;
    const maxAttempts = (retry?.attempts ?? 3) + 1;
    const baseDelayMs = retry?.baseDelayMs ?? 500;

    const request: ModelRequest = {
      model: config.model,
      effort: config.effort,
      thinking: config.thinking,
      maxTokens: config.maxTokens,
      system: this.system,
      tools: [],
      messages: this.history,
      // Rolling tail breakpoint (ADR-0008); refined by the ContextPipeline in step 12.
      cacheBreakpoints: [this.history.length - 1]
    };

    for (let attempt = 1; ; attempt += 1) {
      // Nothing yielded yet this attempt — safe to retry without duplicate output.
      let emitted = false;
      try {
        for await (const event of modelClient.stream(request, signal)) {
          switch (event.type) {
            case 'message_start':
              break;
            case 'text_delta':
              emitted = true;
              yield { type: 'assistant_text_delta', text: event.text };
              break;
            case 'thinking_delta':
              emitted = true;
              yield { type: 'assistant_thinking_delta', text: event.text };
              break;
            case 'tool_use_start':
            case 'tool_use_input_delta':
            case 'tool_use_complete':
              // Tool events surface in step 7; content still lands via message_stop.
              emitted = true;
              break;
            case 'message_stop':
              return {
                stopReason: event.stopReason,
                content: event.content,
                usage: event.usage
              };
            default: {
              const exhaustive: never = event;
              throw new HarnessError('internal', `unhandled stream event: ${String(exhaustive)}`);
            }
          }
        }
        throw new HarnessError('model_request_failed', 'stream ended without message_stop', {
          recoverable: true
        });
      } catch (error) {
        if (!isHarnessError(error) || error.code === 'aborted' || !error.recoverable) {
          throw error;
        }
        // Retrying after partial output would duplicate user-visible text.
        if (emitted || attempt >= maxAttempts) {
          throw error;
        }
        const details = (error.details ?? {}) as { retryAfterMs?: number };
        const backoff =
          details.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.25);
        yield {
          type: 'error',
          severity: 'warning',
          code: error.code,
          message: `${error.message} — retrying (${attempt}/${maxAttempts - 1})`,
          recoverable: true
        };
        await sleep(backoff, signal);
      }
    }
  }
}
