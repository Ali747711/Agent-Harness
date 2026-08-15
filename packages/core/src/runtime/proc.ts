import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable } from 'node:stream';

import { HarnessError } from '../errors/index.ts';

/**
 * Process-spawn adapter — the ONLY place process APIs are touched (ADR-0002,
 * boundary rule 2). Argv arrays only; no shell interpolation ever happens
 * here. Runs on Bun.spawn when the Bun global exists, and falls back to
 * node:child_process otherwise (vitest workers run under Node even when
 * launched via `bun run` — the step-1 spike risk, realized). Buffered output
 * with a byte cap; step 10's CommandRunner adds streaming on top.
 */
export interface RunProcessOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface RunProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4_000_000;

/** Signals mutate across awaits — a call breaks TS's stale narrowing. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface Capped {
  text: string;
  truncated: boolean;
}

async function readCappedWeb(
  stream: ReadableStream<Uint8Array>,
  capBytes: number
): Promise<Capped> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = '';
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > capBytes) {
      truncated = true;
      // Keep draining so the child never blocks on a full pipe.
      continue;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated };
}

function readCappedNode(stream: Readable, capBytes: number): Promise<Capped> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let truncated = false;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > capBytes) {
        truncated = true;
        return; // keep draining
      }
      text += decoder.decode(chunk, { stream: true });
    });
    stream.on('end', () => {
      text += decoder.decode();
      resolve({ text, truncated });
    });
    stream.on('error', reject);
  });
}

async function runWithBun(
  argv: readonly [string, ...string[]],
  options: RunProcessOptions
): Promise<RunProcessResult> {
  const proc = Bun.spawn({
    cmd: [...argv],
    cwd: options.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.env !== undefined && { env: options.env })
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => {
    proc.kill();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const [out, err, exitCode] = await Promise.all([
      readCappedWeb(proc.stdout, cap),
      readCappedWeb(proc.stderr, cap),
      proc.exited
    ]);
    return {
      exitCode,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      timedOut
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function runWithNode(
  argv: readonly [string, ...string[]],
  options: RunProcessOptions
): Promise<RunProcessResult> {
  const [command, ...args] = argv;
  const proc = nodeSpawn(command, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.env !== undefined && { env: options.env })
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => {
    proc.kill('SIGTERM');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const exited = new Promise<number>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => {
        resolve(code ?? -1);
      });
    });
    const [out, err, exitCode] = await Promise.all([
      // stdout/stderr are non-null with the 'pipe' stdio config above.
      readCappedNode(proc.stdout as Readable, cap),
      readCappedNode(proc.stderr as Readable, cap),
      exited
    ]);
    return {
      exitCode,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
      timedOut
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function runProcess(
  argv: readonly string[],
  options: RunProcessOptions
): Promise<RunProcessResult> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw new HarnessError('internal', 'runProcess requires a non-empty argv');
  }
  if (isAborted(options.signal)) {
    throw new HarnessError('aborted', 'process launch aborted', {
      cause: options.signal?.reason
    });
  }

  const result =
    typeof Bun === 'undefined'
      ? await runWithNode([command, ...rest], options)
      : await runWithBun([command, ...rest], options);

  if (isAborted(options.signal)) {
    throw new HarnessError('aborted', 'process aborted', { cause: options.signal?.reason });
  }
  return result;
}
