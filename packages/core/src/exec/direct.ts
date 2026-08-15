import { spawn } from 'node:child_process';

import { HarnessError } from '../errors/index.ts';
import type { CommandRunner, CommandRunOptions, CommandRunResult } from './runner.ts';

/**
 * Unsandboxed runner (Phase 1). Safety properties it DOES provide:
 *  - own process group (detached) with SIGTERM → grace → SIGKILL to the whole
 *    group on cancel/timeout — no orphaned grandchildren;
 *  - environment scrubbed of secret-shaped variables (ANTHROPIC_API_KEY etc.);
 *  - byte-capped output that keeps draining so children never block on a
 *    full pipe.
 * The actual security boundary is human approval (ADR-0006) until the
 * Phase-2 OS sandbox lands. Uses node:child_process (portable — runs
 * identically under Bun and Node; boundary rule 2 concerns Bun-only APIs).
 */
const SECRET_ENV_PATTERN = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i;
const KILL_GRACE_MS = 2_000;

export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_ENV_PATTERN.test(key)) {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

export class DirectCommandRunner implements CommandRunner {
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(baseEnv: NodeJS.ProcessEnv = process.env) {
    this.baseEnv = baseEnv;
  }

  run(options: CommandRunOptions): Promise<CommandRunResult> {
    if (options.signal.aborted) {
      return Promise.reject(
        new HarnessError('aborted', 'command aborted before launch', {
          cause: options.signal.reason
        })
      );
    }

    const startedAt = Date.now();
    return new Promise<CommandRunResult>((resolve, reject) => {
      const proc = spawn('bash', ['-c', options.command], {
        cwd: options.cwd,
        env: scrubEnv(this.baseEnv),
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
            new HarnessError('internal', `failed to launch bash: ${error.message}`, {
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
}
