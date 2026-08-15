import { spawn } from 'node:child_process';

import { HarnessError } from '../errors/index.ts';
import type { CommandRunOptions, CommandRunResult } from './runner.ts';

/**
 * Shared process machinery for every CommandRunner: own process group with
 * SIGTERM → grace → SIGKILL on cancel/timeout (no orphaned grandchildren),
 * byte-capped output that keeps draining so children never block on a full
 * pipe, and abort handling.
 *
 * Runners differ only in the argv/env they hand over — the sandboxed one
 * wraps the command, the direct one does not — so none of this is duplicated
 * per runner. Uses node:child_process (portable; boundary rule 2 concerns
 * Bun-only APIs).
 */
const KILL_GRACE_MS = 2_000;

export interface SpawnRequest {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

export function runProcess(
  request: SpawnRequest,
  options: CommandRunOptions
): Promise<CommandRunResult> {
  if (options.signal.aborted) {
    return Promise.reject(
      new HarnessError('aborted', 'command aborted before launch', {
        cause: options.signal.reason
      })
    );
  }

  const [file, ...args] = request.argv;
  if (file === undefined) {
    return Promise.reject(new HarnessError('internal', 'empty command argv'));
  }

  const startedAt = Date.now();
  return new Promise<CommandRunResult>((resolve, reject) => {
    const proc = spawn(file, args, {
      cwd: options.cwd,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true // own process group → group-wide kill
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const killGroup = (signalName: 'SIGTERM' | 'SIGKILL'): void => {
      const pid = proc.pid;
      if (pid === undefined) {
        return;
      }
      try {
        process.kill(-pid, signalName); // negative pid = the whole group
      } catch {
        proc.kill(signalName); // group already gone; best effort on the leader
      }
    };

    const terminate = (): void => {
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    const onAbort = (): void => {
      terminate();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) {
        truncated = true;
        return; // keep draining; never block the child on a full pipe
      }
      const text = chunk.toString('utf8');
      if (target === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }
      options.onChunk?.(text);
    };
    proc.stdout.on('data', collect('stdout'));
    proc.stderr.on('data', collect('stderr'));

    const finish = (result: () => CommandRunResult | Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      options.signal.removeEventListener('abort', onAbort);
      const outcome = result();
      if (outcome instanceof Error) {
        reject(outcome);
      } else {
        resolve(outcome);
      }
    };

    proc.on('error', (error) => {
      finish(
        () =>
          new HarnessError('internal', `failed to launch ${file}: ${error.message}`, {
            cause: error
          })
      );
    });

    proc.on('close', (code) => {
      finish(() => {
        if (options.signal.aborted && !timedOut) {
          return new HarnessError('aborted', 'command aborted', {
            cause: options.signal.reason
          });
        }
        return {
          exitCode: code ?? -1,
          stdout,
          stderr,
          truncated,
          timedOut,
          durationMs: Date.now() - startedAt
        };
      });
    });
  });
}
