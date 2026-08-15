import { sep } from 'node:path';

import type { Config } from '../config/schema.ts';
import type { MemoryFile } from '../context/memory.ts';
import type { ContextPipeline } from '../context/pipeline.ts';
import { PassthroughPipeline } from '../context/pipeline.ts';
import { buildSystemPrompt, type EnvironmentSnapshot } from '../context/system-prompt.ts';
import { HarnessError, isHarnessError } from '../errors/index.ts';
import { DirectCommandRunner } from '../exec/direct.ts';
import type { CommandRunner } from '../exec/runner.ts';
import type { ModelClient } from '../model/client.ts';
import { estimateCostUsd } from '../model/pricing.ts';
import type {
  AssistantBlock,
  ModelMessage,
  ModelRequest,
  SystemBlock,
  ToolResultBlock,
  ToolSpec,
  ToolUseBlock
} from '../model/types.ts';
import { PermissionEngine, suggestRules } from '../permissions/engine.ts';
import { resolveWorkspacePath } from '../permissions/guard.ts';
import type { AgentEvent } from '../protocol/events.ts';
import {
  type PermissionChoice,
  type PermissionRequest,
  PROTOCOL_VERSION,
  type StopReason,
  type Usage
} from '../protocol/types.ts';
import {
  makeEntry,
  resolvePath,
  type SessionEntry,
  type SessionSink,
  toModelMessages
} from '../session/index.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolResult } from '../tools/tool.ts';
import { FileTracker } from '../tools/tracker.ts';
import { makeChannel } from './channel.ts';
import { sleep } from './sleep.ts';

/**
 * The agent loop. Owns turn state, exhaustive stop_reason handling, retry
 * policy (the ModelClient never retries), cancellation, the maxTurns guard,
 * tool execution behind the permission gate, and transcript persistence.
 * Emits protocol events only — never writes to stdout (ADR-0003).
 */
export interface AgentSessionOptions {
  config: Config;
  modelClient: ModelClient;
  workspaceRoot: string;
  sessionId?: string;
  /** Transcript sink (ADR-0004). Absent = ephemeral session (tests, one-offs). */
  sink?: SessionSink;
  /** Tool set. Absent = conversation-only agent. */
  tools?: ToolRegistry;
  /**
   * Interactive approver for 'ask' decisions (the TUI wires the permission
   * dialog here; step 13). Absent = auto-deny with guidance (headless).
   */
  onPermissionRequest?: (
    request: PermissionRequest,
    suggestions: string[]
  ) => Promise<PermissionChoice>;
  /** Shell execution seam (step 10); defaults to the unsandboxed runner. */
  runner?: CommandRunner;
  /** Loaded once by the caller at session start (ADR-0009). */
  memory?: readonly MemoryFile[];
  /** Environment facts, snapshotted once — never re-read per turn (ADR-0008). */
  environment?: EnvironmentSnapshot;
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

/** Fallback when the caller supplies no snapshot; still frozen per session. */
function defaultEnvironment(workspaceRoot: string): EnvironmentSnapshot {
  return {
    workspaceRoot,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    isGitRepo: false
  };
}

interface TurnOutcome {
  stopReason: StopReason;
  content: AssistantBlock[];
  usage: Usage;
}

type GateOutcome =
  | { verdict: 'allow' }
  | { verdict: 'deny'; message: string; hint?: string }
  | { verdict: 'aborted' }
  | { verdict: 'fatal'; error: HarnessError };

export class AgentSession {
  readonly sessionId: string;
  private readonly options: AgentSessionOptions;
  private readonly system: SystemBlock[];
  private readonly wireTools: ToolSpec[];
  private history: ModelMessage[] = [];
  private turn = 0;
  private started = false;
  private lastEntryId: string | null = null;

  private readonly permissions: PermissionEngine;
  private readonly fileTracker = new FileTracker();
  private readonly runner: CommandRunner;
  private readonly pipeline: ContextPipeline;
  private readonly memoryLabels: string[];

  constructor(options: AgentSessionOptions) {
    this.runner = options.runner ?? new DirectCommandRunner();
    this.options = options;
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    // Frozen once (ADR-0008): every input to the system prompt is captured
    // here, so the cached prefix is byte-identical on every later turn.
    const memory = options.memory ?? [];
    this.memoryLabels = memory.map((file) => file.label);
    this.system = buildSystemPrompt(
      options.environment ?? defaultEnvironment(options.workspaceRoot),
      memory
    );
    // Computed once: the tool list is part of the cached prefix (ADR-0008)
    // and must be byte-identical on every request of the session.
    this.wireTools = options.tools?.toWireSpecs() ?? [];
    this.pipeline = new PassthroughPipeline({
      config: options.config,
      system: this.system,
      tools: this.wireTools,
      capabilities: options.modelClient.capabilities(options.config.model)
    });
    // Rules were schema-validated at config load; this re-parse cannot fail
    // for config-sourced rules and fails fast for programmatic ones.
    this.permissions = new PermissionEngine({
      mode: options.config.permissionMode,
      allow: options.config.permissions.allow,
      deny: options.config.permissions.deny
    });
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
    // Only real prompts count as turns. Tool results are persisted as
    // user-role entries too, so counting every user entry inflates the number
    // by one per tool batch (observed as "turn 7" after two prompts).
    session.turn = path.filter(
      (entry) => entry.type === 'user' && entry.data.content.some((block) => block.type === 'text')
    ).length;
    session.lastEntryId = path.at(-1)?.id ?? null;
    return session;
  }

  /** Immutable view of the conversation (for tests and, later, the store). */
  get messages(): readonly ModelMessage[] {
    return this.history;
  }

  /** Session-wide token/cost totals from API usage fields only (R9). */
  usage() {
    return this.pipeline.totals();
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
        memoryFiles: this.memoryLabels
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
          const batchOutcome = yield* this.executeToolBatch(outcome.content, signal);
          if (batchOutcome === 'fatal') {
            break;
          }
          if (batchOutcome === 'aborted') {
            // Transcript already closed with interrupted tool_results (R7).
            yield { type: 'session_idle' };
            return;
          }
          continue;
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

  /**
   * Execute every tool_use block of an assistant turn sequentially, feed
   * tool_results back as one user message (persisted), and continue the loop.
   * Fail-closed until step 8: non-readOnly tools are refused outright — only
   * the permission engine may unlock effects. On interrupt, pending calls get
   * explicit "interrupted" error results FIRST so the transcript never ends
   * on a dangling tool_use (which would make resume requests invalid).
   */
  private async *executeToolBatch(
    content: AssistantBlock[],
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, 'continue' | 'aborted' | 'fatal', undefined> {
    const calls = content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    const registry = this.options.tools;
    const results: ToolResultBlock[] = [];
    let aborted = signal.aborted;

    for (const call of calls) {
      if (aborted) {
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: 'Interrupted by user before this tool ran.',
          isError: true
        });
        continue;
      }

      const registered = registry?.get(call.name);
      const startedAt = Date.now();
      let title = call.name;
      let result: ToolResult;

      if (registered === undefined) {
        yield {
          type: 'tool_call_started',
          callId: call.id,
          tool: call.name,
          title,
          input: call.input
        };
        result = {
          ok: false,
          error: {
            message: `unknown tool: ${call.name}`,
            hint: `available tools: ${this.wireTools.map((tool) => tool.name).join(', ') || '(none)'}`
          }
        };
      } else {
        const parsed = registered.schema.safeParse(call.input);
        if (!parsed.success) {
          yield {
            type: 'tool_call_started',
            callId: call.id,
            tool: call.name,
            title,
            input: call.input
          };
          result = {
            ok: false,
            error: {
              message: `invalid input for ${call.name}: ${parsed.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('; ')}`,
              hint: 'fix the arguments and call the tool again'
            }
          };
        } else {
          try {
            title = registered.renderTitle(parsed.data);
          } catch {
            title = call.name;
          }
          yield {
            type: 'tool_call_started',
            callId: call.id,
            tool: call.name,
            title,
            input: call.input
          };

          // plan → guard-resolve effects → engine → (maybe) ask → execute.
          let request: PermissionRequest | null = null;
          let gateError: ToolResult | null = null;
          try {
            request = await this.resolveEffects(
              registered.plan(parsed.data, { workspaceRoot: this.options.workspaceRoot })
            );
          } catch (error) {
            if (isHarnessError(error) && error.code === 'permission_denied') {
              // WorkspaceGuard denial — precedence 0, non-overridable.
              gateError = {
                ok: false,
                error: { message: error.message, hint: 'stay inside the workspace root' }
              };
            } else if (isHarnessError(error) && error.code === 'aborted') {
              aborted = true;
              gateError = {
                ok: false,
                error: { message: 'Interrupted by user during execution.' }
              };
            } else {
              gateError = {
                ok: false,
                error: { message: `tool planning failed: ${String(error)}` }
              };
            }
          }

          if (gateError !== null || request === null) {
            result = gateError ?? { ok: false, error: { message: 'tool planning failed' } };
          } else {
            const gate = yield* this.gate(call.id, request, signal);
            if (gate.verdict === 'fatal') {
              yield this.fatal(gate.error);
              return 'fatal';
            }
            if (gate.verdict === 'aborted') {
              aborted = true;
              result = {
                ok: false,
                error: { message: 'Interrupted by user while awaiting permission.' }
              };
            } else if (gate.verdict === 'deny') {
              result = {
                ok: false,
                error: {
                  message: gate.message,
                  ...(gate.hint !== undefined && { hint: gate.hint })
                }
              };
            } else {
              // Stream live output as tool_call_progress while executing.
              const channel = makeChannel<string>();
              const execution = registered
                .execute(parsed.data, {
                  workspaceRoot: this.options.workspaceRoot,
                  signal,
                  resolvePath: (candidate) =>
                    resolveWorkspacePath(this.options.workspaceRoot, candidate),
                  files: this.fileTracker,
                  runner: this.runner,
                  onProgress: (chunk) => channel.push(chunk)
                })
                .finally(() => channel.close());
              // Rejections are re-awaited below; this guard just keeps the gap
              // between channel close and the await from being "unhandled".
              execution.catch(() => undefined);
              for await (const chunk of channel) {
                yield { type: 'tool_call_progress', callId: call.id, chunk };
              }
              try {
                result = await execution;
              } catch (error) {
                if (isHarnessError(error) && error.code === 'aborted') {
                  aborted = true;
                  result = {
                    ok: false,
                    error: { message: 'Interrupted by user during execution.' }
                  };
                } else {
                  result = {
                    ok: false,
                    error: { message: `tool crashed: ${String(error)}` }
                  };
                }
              }
            }
          }
        }
      }

      const resultText = result.ok
        ? result.content
        : `Error: ${result.error.message}${result.error.hint === undefined ? '' : `\nHint: ${result.error.hint}`}`;
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: resultText,
        ...(result.ok ? {} : { isError: true })
      });
      yield {
        type: 'tool_call_completed',
        callId: call.id,
        ok: result.ok,
        summary: result.ok ? result.summary : result.error.message.slice(0, 200),
        durationMs: Date.now() - startedAt
      };
    }

    this.history = [...this.history, { role: 'user', content: results }];
    const persistError = await this.tryAppend({
      type: 'user',
      data: { content: results }
    });
    if (persistError !== null) {
      yield this.fatal(persistError);
      return 'fatal';
    }
    return aborted ? 'aborted' : 'continue';
  }

  /**
   * Canonicalize every path effect through the WorkspaceGuard BEFORE the
   * engine sees the request — escapes are denied here (non-overridable) and
   * rules match against resolved, '/'-separated relative paths only.
   */
  private async resolveEffects(request: PermissionRequest): Promise<PermissionRequest> {
    const effects = await Promise.all(
      request.effects.map(async (effect) => {
        if (effect.path === undefined) {
          return effect;
        }
        const resolved = await resolveWorkspacePath(this.options.workspaceRoot, effect.path);
        return { ...effect, path: resolved.relative.split(sep).join('/') };
      })
    );
    return { ...request, effects };
  }

  /**
   * Engine decision + interactive ask round-trip. Emits permission events,
   * persists the decision, and records session grants.
   */
  private async *gate(
    callId: string,
    request: PermissionRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, GateOutcome, undefined> {
    const decision = this.permissions.evaluate(request);
    if (decision.kind === 'allow') {
      return { verdict: 'allow' };
    }
    if (decision.kind === 'deny') {
      return {
        verdict: 'deny',
        message: `permission denied: ${decision.reason}`,
        hint: 'an operator can adjust permissions.allow/deny in .harness/config.json'
      };
    }

    const requestId = crypto.randomUUID();
    const suggestions = suggestRules(request);
    const interactive = this.options.onPermissionRequest !== undefined;
    yield { type: 'permission_requested', requestId, callId, request, suggestions };

    let choice: PermissionChoice;
    try {
      choice = await this.awaitPermission(request, suggestions, signal);
    } catch (error) {
      if (isHarnessError(error) && error.code === 'aborted') {
        return { verdict: 'aborted' };
      }
      choice = 'deny'; // a broken approver must never become an approval
    }

    const by = interactive ? ('user' as const) : ('rule' as const);
    yield { type: 'permission_resolved', requestId, choice, by };
    const persistError = await this.tryAppend({
      type: 'permission',
      data: { requestId, tool: request.tool, choice, by }
    });
    if (persistError !== null) {
      return { verdict: 'fatal', error: persistError };
    }

    if (choice === 'deny') {
      return {
        verdict: 'deny',
        message: interactive
          ? 'permission denied by user'
          : 'permission denied: no interactive approver in this mode',
        hint: interactive
          ? 'propose a different approach or explain why this action is needed'
          : `re-run with --permission-mode acceptEdits, or add an allow rule (e.g. ${suggestions[0] ?? `${request.tool}(...)`})`
      };
    }
    if (choice === 'allow_session') {
      this.permissions.recordGrant(request);
    }
    return { verdict: 'allow' };
  }

  /** Race the approver against the abort signal — interrupt stays instant. */
  private awaitPermission(
    request: PermissionRequest,
    suggestions: string[],
    signal: AbortSignal
  ): Promise<PermissionChoice> {
    const responder =
      this.options.onPermissionRequest ?? (() => Promise.resolve<PermissionChoice>('deny'));
    return new Promise<PermissionChoice>((resolve, reject) => {
      if (signal.aborted) {
        reject(new HarnessError('aborted', 'interrupted while awaiting permission'));
        return;
      }
      const onAbort = (): void => {
        reject(new HarnessError('aborted', 'interrupted while awaiting permission'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      responder(request, suggestions).then(
        (choice) => {
          signal.removeEventListener('abort', onAbort);
          resolve(choice);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
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

    const request: ModelRequest = this.pipeline.build({ messages: this.history });

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
              this.pipeline.observeUsage(event.usage);
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
