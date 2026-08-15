import { HarnessError } from '../errors/index.ts';
import { scrubEnv } from './direct.ts';
import type { CommandRunner, CommandRunOptions, CommandRunResult } from './runner.ts';
import { runProcess } from './spawn.ts';

/**
 * OS-enforced confinement for bash (ADR-0006, Phase 2). Wraps each command
 * with @anthropic-ai/sandbox-runtime — `sandbox-exec` on macOS, `bubblewrap`
 * on Linux — so the filesystem boundary stops being a promise the model has
 * to keep and becomes one the kernel enforces.
 *
 * This closes the hole SAFETY.md documented: bash declares only
 * `{kind: 'execute'}`, so WorkspaceGuard never sees its paths and even a
 * denied write could previously be attempted anywhere the user could write.
 *
 * The runtime is imported LAZILY. It ships vendored binaries and resolves
 * platform helpers at import time, which is exactly what broke @vscode/ripgrep
 * inside `bun build --compile`; sessions that never enable the sandbox must
 * never pay that cost.
 */
export interface SandboxPolicy {
  /** Writable roots. The workspace is added by the caller, not assumed here. */
  allowWrite: readonly string[];
  /** Reads to deny — credential stores, key material. */
  denyRead: readonly string[];
  /**
   * Domains reachable through the sandbox proxy. An empty list denies all
   * egress; the runtime has no "allow everything" setting.
   */
  allowedDomains: readonly string[];
}

export interface SandboxStatus {
  platform: string;
  supported: boolean;
  errors: string[];
  warnings: string[];
}

/** Minimal structural view of the bits of SandboxManager we depend on. */
export interface SandboxManagerLike {
  initialize(config: unknown): Promise<void>;
  isSupportedPlatform(): boolean;
  checkDependenciesAsync(): Promise<{ errors: string[]; warnings: string[] }>;
  wrapWithSandboxArgv(
    command: string,
    binShell: string | undefined,
    customConfig: unknown,
    abortSignal: AbortSignal | undefined,
    cwd: string | undefined,
    options: { commandId?: string }
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  annotateStderrWithSandboxFailures(commandId: string, stderr: string): string;
  cleanupAfterCommand(): void;
}

/** Structural view of the runtime's own zod schema (it bundles zod 3). */
interface ConfigSchemaLike {
  safeParse(value: unknown): { success: boolean; error?: { issues: { path: unknown[] }[] } };
}

let configSchema: ConfigSchemaLike | null = null;

/**
 * Validate against the runtime's OWN schema before handing it over.
 * `initialize()` accepts an incomplete config and then fails silently at
 * runtime, so this is the only place a missing field can be caught.
 */
export function assertRuntimeConfig(schema: ConfigSchemaLike | null, config: unknown): void {
  const result = schema?.safeParse(config);
  if (result !== undefined && !result.success) {
    const fields = (result.error?.issues ?? []).map((issue) => issue.path.join('.')).join(', ');
    throw new HarnessError(
      'internal',
      `sandbox config rejected by the runtime schema (${fields}) — refusing to run with a ` +
        'config that would silently misbehave'
    );
  }
}

async function loadManager(): Promise<SandboxManagerLike> {
  try {
    const runtime = (await import('@anthropic-ai/sandbox-runtime')) as {
      SandboxManager: SandboxManagerLike;
      SandboxRuntimeConfigSchema?: ConfigSchemaLike;
    };
    configSchema = runtime.SandboxRuntimeConfigSchema ?? null;
    return runtime.SandboxManager;
  } catch (error) {
    throw new HarnessError(
      'internal',
      `sandbox runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

/**
 * The wrapper derives its env from process.env, which would undo scrubEnv and
 * hand the child back ANTHROPIC_API_KEY. Scrub it — but keep keys the wrapper
 * *introduced*, since a key absent from the base env is sandbox plumbing
 * (proxy address, CA bundle) and cannot be one of the user's secrets.
 */
export function mergeSandboxEnv(
  base: NodeJS.ProcessEnv,
  wrapped: NodeJS.ProcessEnv
): Record<string, string> {
  const env = scrubEnv(wrapped);
  for (const [key, value] of Object.entries(wrapped)) {
    if (value !== undefined && !(key in base)) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Config in the shape the runtime expects. Pure, so the mapping is testable.
 *
 * Every field here is REQUIRED by SandboxRuntimeConfigSchema, including the
 * empty deny lists. `SandboxManager.initialize()` does NOT validate, so an
 * incomplete config is accepted and then misbehaves silently: omitting
 * `deniedDomains` left the proxy accepting CONNECT and hanging upstream
 * forever, which looked exactly like "the sandbox blocks all egress". The
 * package's own CLI rejects the same config outright — that discrepancy is
 * what the validation in `ready()` now closes.
 */
export function toRuntimeConfig(policy: SandboxPolicy): {
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
} {
  return {
    // Omitting `network` entirely throws inside the runtime on
    // network.parentProxy; omitting its deny list breaks egress silently.
    network: { allowedDomains: [...policy.allowedDomains], deniedDomains: [] },
    filesystem: {
      denyRead: [...policy.denyRead],
      allowWrite: [...policy.allowWrite],
      denyWrite: []
    }
  };
}

/** For `harness doctor`: can this machine sandbox, and what is missing? */
export async function probeSandbox(): Promise<SandboxStatus> {
  const base = { platform: process.platform, supported: false, errors: [], warnings: [] };
  let manager: SandboxManagerLike;
  try {
    manager = await loadManager();
  } catch (error) {
    return { ...base, errors: [error instanceof Error ? error.message : String(error)] };
  }
  if (!manager.isSupportedPlatform()) {
    return {
      ...base,
      errors: [`sandboxing is not supported on ${process.platform}`]
    };
  }
  const deps = await manager.checkDependenciesAsync();
  return {
    platform: process.platform,
    supported: deps.errors.length === 0,
    errors: [...deps.errors],
    warnings: [...deps.warnings]
  };
}

export class SandboxedCommandRunner implements CommandRunner {
  private manager: SandboxManagerLike | null = null;
  private starting: Promise<SandboxManagerLike> | null = null;
  private commandSeq = 0;

  constructor(
    private readonly policy: SandboxPolicy,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    /** Injectable so fail-closed behaviour is testable without the runtime. */
    private readonly load: () => Promise<SandboxManagerLike> = loadManager
  ) {}

  /**
   * Fails CLOSED. If the platform cannot sandbox or a dependency is missing we
   * refuse to run rather than quietly falling back to an unconfined shell —
   * a user who believes they are sandboxed and is not is worse off than one
   * who knows they are not.
   */
  private async ready(): Promise<SandboxManagerLike> {
    if (this.manager !== null) {
      return this.manager;
    }
    this.starting ??= (async () => {
      const manager = await this.load();
      if (!manager.isSupportedPlatform()) {
        throw new HarnessError(
          'permission_denied',
          `sandbox is enabled but not supported on ${process.platform}`,
          { details: { remediation: 'set sandbox.enabled=false to run commands unconfined' } }
        );
      }
      const deps = await manager.checkDependenciesAsync();
      if (deps.errors.length > 0) {
        throw new HarnessError(
          'permission_denied',
          `sandbox dependencies missing: ${deps.errors.join('; ')}`,
          {
            details: {
              remediation: 'install the listed dependencies, or set sandbox.enabled=false'
            }
          }
        );
      }
      const runtimeConfig = toRuntimeConfig(this.policy);
      assertRuntimeConfig(configSchema, runtimeConfig);
      await manager.initialize(runtimeConfig);
      this.manager = manager;
      return manager;
    })();
    return this.starting;
  }

  async run(options: CommandRunOptions): Promise<CommandRunResult> {
    const manager = await this.ready();

    // A unique id per call: the runtime attributes violations by this key and
    // compares only the first 100 characters, so two long commands sharing a
    // prefix would otherwise cross-attribute.
    this.commandSeq += 1;
    const commandId = `harness-${this.commandSeq}`;

    const wrapped = await manager.wrapWithSandboxArgv(
      options.command,
      undefined,
      undefined,
      options.signal,
      options.cwd,
      { commandId }
    );

    try {
      return await runProcess(
        {
          argv: wrapped.argv,
          env: mergeSandboxEnv(this.baseEnv, wrapped.env),
          // Seatbelt/seccomp denials surface as bare "Operation not permitted";
          // the runtime turns them back into which rule blocked what.
          annotateStderr: (stderr) => manager.annotateStderrWithSandboxFailures(commandId, stderr)
        },
        options
      );
    } finally {
      manager.cleanupAfterCommand();
    }
  }
}
