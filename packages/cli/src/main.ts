#!/usr/bin/env bun
/**
 * @harness/cli entrypoint. Headless mode ships in Phase 1A (M1); the
 * interactive TUI lands in step 13.
 */
import { type Config, isHarnessError, loadConfig } from '@harness/core';
import { Command } from 'commander';

import { flagsFromCli, type RawCliOptions } from './args/options.ts';
import { type OutputFormat, runHeadless } from './headless/run.ts';

const VERSION = '0.0.1';
const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'jsonl'];

function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

async function main(): Promise<number> {
  const program = new Command()
    .name('harness')
    .description('local terminal coding-agent harness')
    .version(VERSION)
    .option('-p, --print <prompt>', 'run one prompt headless and exit')
    .option('--output-format <format>', 'headless output: text | json | jsonl', 'text')
    .option('--model <model>', 'model id (e.g. claude-opus-5)')
    .option('--effort <effort>', 'low | medium | high | xhigh | max')
    .option('--thinking <mode>', 'adaptive | disabled')
    .option('--max-tokens <n>', 'max output tokens per request')
    .option('--max-turns <n>', 'max model requests per prompt')
    .option('--permission-mode <mode>', 'default | acceptEdits | bypass')
    .option('--cwd <dir>', 'workspace root (defaults to the current directory)');

  program.parse();
  const raw = program.opts<RawCliOptions>();
  const workspaceRoot = raw.cwd ?? process.cwd();
  const format = raw.outputFormat ?? 'text';

  if (!isOutputFormat(format)) {
    process.stderr.write(`unknown --output-format "${format}" (use text | json | jsonl)\n`);
    return 2;
  }

  let config: Config;
  try {
    ({ config } = await loadConfig({
      cwd: workspaceRoot,
      env: process.env,
      flags: flagsFromCli(raw)
    }));
  } catch (error) {
    const message = isHarnessError(error)
      ? `${error.message}\n${JSON.stringify(error.details ?? {}, null, 2)}`
      : String(error);
    process.stderr.write(`config error: ${message}\n`);
    return 2;
  }

  if (raw.print === undefined) {
    process.stderr.write(
      'interactive mode lands in step 13 — run headless for now: harness -p "<prompt>"\n'
    );
    return 2;
  }

  if (process.env.ANTHROPIC_API_KEY === undefined) {
    process.stderr.write(
      'ANTHROPIC_API_KEY is not set. Export it and retry (config files never hold keys).\n'
    );
    return 2;
  }

  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  process.once('SIGTERM', () => {
    controller.abort();
  });

  return runHeadless({
    prompt: raw.print,
    format,
    config,
    workspaceRoot,
    signal: controller.signal
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
