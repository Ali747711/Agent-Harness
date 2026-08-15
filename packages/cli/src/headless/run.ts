import {
  type AgentEvent,
  AgentSession,
  builtinToolRegistry,
  type Config,
  createAnthropicModelClient,
  JsonlSessionStore,
  type ModelClient,
  type OpenedSession,
  projectSessionsDir
} from '@harness/core';

/**
 * Headless client (R6): consumes the protocol event stream and writes to
 * stdout. `jsonl` is one JSON event per line — the serializability proof for
 * the whole protocol (ADR-0003). Returns the process exit code:
 * 0 success · 1 failed · 130 interrupted.
 */
export type OutputFormat = 'text' | 'json' | 'jsonl';

export interface HeadlessOptions {
  prompt: string;
  format: OutputFormat;
  config: Config;
  workspaceRoot: string;
  signal: AbortSignal;
  /**
   * Where JSONL transcripts are written (R5). Defaults to
   * ~/.harness/projects/<slug>-<hash>/; pass null to run without one.
   */
  transcriptDir?: string | null;
}

export interface HeadlessDeps {
  modelClient?: ModelClient;
  writeOut?: (chunk: string) => void;
  writeErr?: (chunk: string) => void;
}

export async function runHeadless(
  options: HeadlessOptions,
  deps: HeadlessDeps = {}
): Promise<number> {
  const writeOut =
    deps.writeOut ??
    ((chunk: string): void => {
      process.stdout.write(chunk);
    });
  const writeErr =
    deps.writeErr ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    });
  const modelClient = deps.modelClient ?? createAnthropicModelClient();

  // ADR-0006: bypass is an explicit, loud opt-out — the bash tool is not
  // workspace-confined, so this mode has no effective filesystem boundary
  // beyond OS file permissions (see SAFETY.md).
  if (options.config.permissionMode === 'bypass') {
    writeErr(
      'WARNING: --permission-mode bypass — writes and shell commands run without approval.\n' +
        '         bash is NOT confined to the workspace; it can reach any file your user can.\n' +
        '         Explicit deny rules still apply. See SAFETY.md.\n'
    );
  }

  // R5: every session writes a JSONL transcript. A transcript failure must
  // never cost the user their run — warn and continue without one.
  const transcriptDir =
    options.transcriptDir === undefined
      ? projectSessionsDir(options.workspaceRoot)
      : options.transcriptDir;
  let opened: OpenedSession | null = null;
  if (transcriptDir !== null) {
    try {
      opened = await new JsonlSessionStore(transcriptDir).create({
        workspaceRoot: options.workspaceRoot,
        model: options.config.model
      });
    } catch (error) {
      writeErr(`warning: no session transcript (${String(error)}); continuing without one\n`);
    }
  }

  const sessionOptions = {
    config: options.config,
    modelClient,
    workspaceRoot: options.workspaceRoot,
    tools: builtinToolRegistry()
  };
  const session =
    opened === null
      ? new AgentSession(sessionOptions)
      : AgentSession.fromEntries(opened.entries, { ...sessionOptions, sink: opened.sink });

  const collected: AgentEvent[] = [];
  let failed = false;
  let wroteText = false;

  try {
    for await (const event of session.run(options.prompt, options.signal)) {
      if (event.type === 'error' && event.severity !== 'warning') {
        failed = true;
      }
      switch (options.format) {
        case 'jsonl':
          writeOut(`${JSON.stringify(event)}\n`);
          break;
        case 'json':
          collected.push(event);
          break;
        case 'text': {
          if (event.type === 'assistant_text_delta') {
            writeOut(event.text);
            wroteText = true;
          } else if (event.type === 'error') {
            writeErr(`${wroteText ? '\n' : ''}error (${event.code}): ${event.message}\n`);
            wroteText = false;
          }
          break;
        }
        default: {
          const exhaustive: never = options.format;
          throw new Error(`unreachable output format: ${String(exhaustive)}`);
        }
      }
    }

    if (options.format === 'json') {
      writeOut(`${JSON.stringify(collected, null, 2)}\n`);
    }
    if (options.format === 'text' && wroteText) {
      writeOut('\n');
    }

    if (options.signal.aborted) {
      return 130;
    }
    return failed ? 1 : 0;
  } finally {
    // Close even on interrupt so the transcript is flushed and resumable.
    await opened?.sink.close().catch(() => undefined);
  }
}
