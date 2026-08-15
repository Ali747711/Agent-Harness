import {
  type AgentEvent,
  AgentSession,
  type Config,
  createAnthropicModelClient,
  type ModelClient
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

  const session = new AgentSession({
    config: options.config,
    modelClient,
    workspaceRoot: options.workspaceRoot
  });

  const collected: AgentEvent[] = [];
  let failed = false;
  let wroteText = false;

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
}
