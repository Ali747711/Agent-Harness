#!/usr/bin/env bun
/**
 * @harness/cli entrypoint: interactive TUI by default, headless with -p.
 */
import {
  type Config,
  indexDbPath,
  isHarnessError,
  loadConfig,
  projectSessionsDir,
  redactSecrets,
  SessionIndex
} from '@harness/core';
import { Command } from 'commander';

import { flagsFromCli, type RawCliOptions } from './args/options.ts';
import { type OutputFormat, runHeadless } from './headless/run.ts';
import { runInteractive } from './interactive/run.ts';

const VERSION = '0.0.1';
const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'jsonl'];

function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

interface CliOptions extends RawCliOptions {
  resume?: string;
  continue?: boolean;
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

async function listSessions(workspaceRoot: string): Promise<number> {
  const index = await SessionIndex.open(indexDbPath());
  try {
    // The index is derived — rebuild from disk so a stale/missing DB still lists.
    await index.reindex(projectSessionsDir(workspaceRoot));
    const sessions = index.list(workspaceRoot);
    if (sessions.length === 0) {
      process.stdout.write('no sessions yet for this project\n');
      return 0;
    }
    for (const session of sessions) {
      process.stdout.write(
        `${session.sessionId}  ${relativeAge(session.updatedAt).padEnd(9)} ${String(session.messageCount).padStart(3)} msg  ${session.title}\n`
      );
    }
    return 0;
  } finally {
    index.close();
  }
}

async function resolveResumeId(
  raw: CliOptions,
  workspaceRoot: string
): Promise<{ id?: string; error?: string }> {
  if (raw.resume !== undefined) {
    return { id: raw.resume };
  }
  if (raw.continue !== true) {
    return {};
  }
  const index = await SessionIndex.open(indexDbPath());
  try {
    await index.reindex(projectSessionsDir(workspaceRoot));
    const latest = index.latest(workspaceRoot);
    return latest === undefined
      ? { error: 'no previous session for this project' }
      : { id: latest.sessionId };
  } finally {
    index.close();
  }
}

async function main(): Promise<number> {
  const program = new Command()
    .name('harness')
    .description('local terminal coding-agent harness')
    .version(VERSION)
    .argument('[command]', 'optional subcommand: sessions')
    .argument('[subcommand]', 'for "sessions": list')
    .option('-p, --print <prompt>', 'run one prompt headless and exit')
    .option('--output-format <format>', 'headless output: text | json | jsonl', 'text')
    .option('-c, --continue', 'resume the most recent session for this project')
    .option('-r, --resume <sessionId>', 'resume a specific session')
    .option('--model <model>', 'model id (e.g. claude-opus-5)')
    .option('--effort <effort>', 'low | medium | high | xhigh | max')
    .option('--thinking <mode>', 'adaptive | disabled')
    .option('--max-tokens <n>', 'max output tokens per request')
    .option('--max-turns <n>', 'max model requests per prompt')
    .option('--permission-mode <mode>', 'default | acceptEdits | bypass')
    .option('--cwd <dir>', 'workspace root (defaults to the current directory)')
    .allowExcessArguments(true);

  program.parse();
  const raw = program.opts<CliOptions>();
  const [command, subcommand] = program.args;
  const workspaceRoot = raw.cwd ?? process.cwd();
  const format = raw.outputFormat ?? 'text';

  if (command === 'sessions') {
    if (subcommand !== undefined && subcommand !== 'list') {
      process.stderr.write(`unknown sessions subcommand "${subcommand}" (only: list)\n`);
      return 2;
    }
    return listSessions(workspaceRoot);
  }

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
    process.stderr.write(`config error: ${redactSecrets(message)}\n`);
    return 2;
  }

  if (process.env.ANTHROPIC_API_KEY === undefined) {
    process.stderr.write(
      'ANTHROPIC_API_KEY is not set. Export it and retry (config files never hold keys).\n'
    );
    return 2;
  }

  if (raw.print === undefined) {
    const resume = await resolveResumeId(raw, workspaceRoot);
    if (resume.error !== undefined) {
      process.stderr.write(`${resume.error}\n`);
      return 2;
    }
    return runInteractive({
      config,
      workspaceRoot,
      version: VERSION,
      ...(resume.id !== undefined && { resumeSessionId: resume.id })
    });
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

// Last-resort guards: nothing may escape as an unhandled rejection or an
// unredacted crash dump (step 15).
process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`fatal (unhandled rejection): ${redactSecrets(String(reason))}\n`);
  process.exitCode = 1;
});

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${redactSecrets(String(error))}\n`);
    process.exitCode = 1;
  });
