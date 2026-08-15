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

/** Measured: the macOS log monitor needs ~250ms to attribute a violation. */
const VIOLATION_SETTLE_MS = 300;
const LOOKS_DENIED = /operation not permitted|permission denied/i;

export interface SandboxStatus {
  platform: string;
  supported: boolean;
  errors: string[];
  warnings: string[];
}

/** Minimal structural view of the bits of SandboxManager we depend on. */
export interface SandboxManagerLike {
  initialize(config: unknown, askCallback?: undefined, enableLogMonitor?: boolean): Promise<void>;
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
  reset(): Promise<void>;
}

/**
 * The runtime's SandboxManager is a process-global singleton, so teardown is
 * global too rather than per-runner.
 *
 * This is not optional bookkeeping: `enableLogMonitor` holds an open handle
 * that keeps the event loop alive, so a process that initialized the sandbox
 * and does not reset it NEVER EXITS. Verified — without this the CLI hangs on
 * quit whenever sandbox.enabled is true.
 */
let activeManager: SandboxManagerLike | null = null;

export async function disposeSandbox(): Promise<void> {
  const manager = activeManager;
  activeManager = null;
  if (manager === null) {
    return;
  }
  manager.cleanupAfterCommand();
  await manager.reset();
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
      // enableLogMonitor: without it a denied WRITE surfaces only as a bare
      // "Operation not permitted", which tells the model nothing it can act
      // on. With it, the same failure carries `deny(1) file-write-create
      // <path>` — the difference between the agent retrying blindly and it
      // reporting which path the policy refused (R10, legible failure).
      await manager.initialize(runtimeConfig, undefined, true);
      this.manager = manager;
      activeManager = manager; // so disposeSandbox() can release the monitor
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
      const result = await runProcess(
        { argv: wrapped.argv, env: mergeSandboxEnv(this.baseEnv, wrapped.env) },
        options
      );
      return { ...result, stderr: await this.explain(manager, commandId, result) };
    } finally {
      manager.cleanupAfterCommand();
    }
  }

  /**
   * Turn a bare denial into one that names the rule that caused it.
   *
   * Network denials come back in-band (the proxy answers 403) and annotate
   * immediately. Filesystem denials arrive via an async log monitor that needs
   * roughly a quarter second, so a short settle is required — but only when
   * the failure actually looks like a denial. A test suite exiting non-zero is
   * the common case and must not pay for it.
   */
  private async explain(
    manager: SandboxManagerLike,
    commandId: string,
    result: CommandRunResult
  ): Promise<string> {
    if (result.exitCode === 0) {
      return result.stderr;
    }
    const annotated = manager.annotateStderrWithSandboxFailures(commandId, result.stderr);
    if (annotated !== result.stderr || !LOOKS_DENIED.test(result.stderr)) {
      return annotated;
    }
    await new Promise((resolve) => setTimeout(resolve, VIOLATION_SETTLE_MS));
    return manager.annotateStderrWithSandboxFailures(commandId, result.stderr);
  }
}
