import type { CommandRunner, CommandRunOptions, CommandRunResult } from './runner.ts';
import { runProcess } from './spawn.ts';

/**
 * Unsandboxed runner. Safety properties it DOES provide (all from runProcess,
 * plus the env scrub here):
 *  - own process group with group-wide SIGTERM → SIGKILL on cancel/timeout;
 *  - environment scrubbed of secret-shaped variables (ANTHROPIC_API_KEY etc.);
 *  - byte-capped output.
 *
 * What it does NOT provide is confinement: a command run through this runner
 * can read and write anywhere the user can. The security boundary is human
 * approval (ADR-0006). Use SandboxedCommandRunner for OS-enforced limits.
 */
const SECRET_ENV_PATTERN = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i;

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
    return runProcess(
      { argv: ['bash', '-c', options.command], env: scrubEnv(this.baseEnv) },
      options
    );
  }
}
