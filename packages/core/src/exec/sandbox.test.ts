import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_DEFAULTS } from '../config/schema.ts';
import { isHarnessError } from '../errors/index.ts';
import { DirectCommandRunner } from './direct.ts';
import { createCommandRunner, credentialDenyPaths, sandboxPolicyFor } from './policy.ts';
import type { CommandRunOptions } from './runner.ts';
import {
  assertRuntimeConfig,
  mergeSandboxEnv,
  probeSandbox,
  SandboxedCommandRunner,
  type SandboxManagerLike,
  toRuntimeConfig
} from './sandbox.ts';

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'harness-sbx-'));
  outside = await mkdtemp(join(tmpdir(), 'harness-out-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function options(overrides: Partial<CommandRunOptions> = {}): CommandRunOptions {
  return {
    command: 'true',
    cwd: workspace,
    timeoutMs: 20_000,
    maxOutputBytes: 1_000_000,
    signal: AbortSignal.timeout(30_000),
    ...overrides
  };
}

/** A manager stub; lets the fail-closed paths be asserted with no real sandbox. */
function stubManager(overrides: Partial<SandboxManagerLike> = {}): SandboxManagerLike {
  return {
    initialize: async () => undefined,
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: async (command) => ({
      argv: ['bash', '-c', command],
      env: { ...process.env }
    }),
    annotateStderrWithSandboxFailures: (_id, stderr) => stderr,
    cleanupAfterCommand: () => undefined,
    ...overrides
  };
}

describe('policy mapping', () => {
  it('always makes the workspace writable and denies credential stores', () => {
    const policy = sandboxPolicyFor(workspace, CONFIG_DEFAULTS.sandbox, {
      home: '/home/u',
      tmp: '/tmp'
    });
    expect(policy.allowWrite).toContain(workspace);
    expect(policy.allowWrite).toContain('/tmp');
    expect(policy.denyRead).toContain('/home/u/.ssh');
    expect(policy.denyRead).toContain('/home/u/.aws');
  });

  it('appends configured paths without dropping the defaults', () => {
    const policy = sandboxPolicyFor(
      workspace,
      {
        enabled: true,
        allowWrite: ['/srv/cache'],
        denyRead: ['/secret'],
        allowedDomains: ['a.io']
      },
      { home: '/home/u', tmp: '/tmp' }
    );
    expect(policy.allowWrite).toContain('/srv/cache');
    expect(policy.denyRead).toContain('/secret');
    expect(policy.denyRead).toContain('/home/u/.ssh');
    expect(policy.allowedDomains).toEqual(['a.io']);
  });

  it('denies only paths outside the workspace, so bash and read agree', () => {
    // An in-workspace deny would block `cat .env` while `read .env` still
    // worked — two different answers to "is this readable?".
    for (const path of credentialDenyPaths('/home/u')) {
      expect(path.startsWith('/home/u')).toBe(true);
    }
  });

  it('config decides which runner the session gets', () => {
    const off = createCommandRunner(workspace, CONFIG_DEFAULTS);
    expect(off).toBeInstanceOf(DirectCommandRunner);
    const on = createCommandRunner(workspace, {
      ...CONFIG_DEFAULTS,
      sandbox: { ...CONFIG_DEFAULTS.sandbox, enabled: true }
    });
    expect(on).toBeInstanceOf(SandboxedCommandRunner);
  });

  it('emits the network key the runtime requires', () => {
    // Omitting `network` makes the runtime throw on network.parentProxy.
    const config = toRuntimeConfig({ allowWrite: ['/w'], denyRead: [], allowedDomains: [] });
    expect(config.network.allowedDomains).toEqual([]);
    expect(config.filesystem.allowWrite).toEqual(['/w']);
  });

  it('emits the empty deny lists the runtime schema requires', async () => {
    // Regression: omitting deniedDomains/denyWrite produced a config that
    // initialize() ACCEPTED and then broke — the proxy took the CONNECT and
    // hung upstream forever, indistinguishable from "egress is denied".
    // Validating against the runtime's own schema catches it with no network.
    const { SandboxRuntimeConfigSchema } = await import('@anthropic-ai/sandbox-runtime');
    const config = toRuntimeConfig({
      allowWrite: ['/w'],
      denyRead: ['/secret'],
      allowedDomains: ['example.com']
    });
    expect(SandboxRuntimeConfigSchema.safeParse(config).success).toBe(true);
  });
});

describe('assertRuntimeConfig', () => {
  const schema = {
    safeParse: (value: unknown) =>
      (value as { network?: { deniedDomains?: unknown } }).network?.deniedDomains === undefined
        ? { success: false, error: { issues: [{ path: ['network', 'deniedDomains'] }] } }
        : { success: true }
  };

  it('refuses a config the runtime would accept and then misbehave on', () => {
    expect(() => assertRuntimeConfig(schema, { network: {} })).toThrow(/network.deniedDomains/);
  });

  it('passes a valid config through', () => {
    expect(() => assertRuntimeConfig(schema, { network: { deniedDomains: [] } })).not.toThrow();
  });

  it('is a no-op when the runtime exposes no schema', () => {
    expect(() => assertRuntimeConfig(null, { anything: true })).not.toThrow();
  });
});

describe('mergeSandboxEnv', () => {
  it('re-scrubs secrets the wrapper reintroduced from process.env', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-secret', PATH: '/usr/bin' };
    const merged = mergeSandboxEnv(base, { ANTHROPIC_API_KEY: 'sk-secret', PATH: '/usr/bin' });
    expect(merged.ANTHROPIC_API_KEY).toBeUndefined();
    expect(merged.PATH).toBe('/usr/bin');
  });

  it('keeps sandbox plumbing the wrapper injected, even secret-shaped keys', () => {
    // A key absent from the base env cannot be one of the user's secrets.
    const merged = mergeSandboxEnv(
      { PATH: '/usr/bin' },
      { PATH: '/usr/bin', HTTPS_PROXY: 'http://localhost:1', SRT_AUTH_TOKEN: 'plumbing' }
    );
    expect(merged.HTTPS_PROXY).toBe('http://localhost:1');
    expect(merged.SRT_AUTH_TOKEN).toBe('plumbing');
  });
});

describe('SandboxedCommandRunner fails closed', () => {
  const policy = { allowWrite: ['/w'], denyRead: [], allowedDomains: [] };

  it('refuses to run on an unsupported platform instead of running unconfined', async () => {
    const runner = new SandboxedCommandRunner(policy, {}, async () =>
      stubManager({ isSupportedPlatform: () => false })
    );
    await expect(runner.run(options({ command: 'echo nope' }))).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.code === 'permission_denied'
    );
  });

  it('refuses to run when a dependency is missing', async () => {
    const runner = new SandboxedCommandRunner(policy, {}, async () =>
      stubManager({
        checkDependenciesAsync: async () => ({ errors: ['bubblewrap not found'], warnings: [] })
      })
    );
    await expect(runner.run(options())).rejects.toSatisfy(
      (error: unknown) =>
        isHarnessError(error) && /bubblewrap not found/.test((error as Error).message)
    );
  });

  it('initializes the runtime once across many commands', async () => {
    let inits = 0;
    const runner = new SandboxedCommandRunner(policy, { PATH: process.env.PATH ?? '' }, async () =>
      stubManager({
        initialize: async () => {
          inits += 1;
        }
      })
    );
    await runner.run(options({ command: 'echo one' }));
    await runner.run(options({ command: 'echo two' }));
    expect(inits).toBe(1);
  });

  it('routes stderr through the runtime annotator', async () => {
    const runner = new SandboxedCommandRunner(policy, { PATH: process.env.PATH ?? '' }, async () =>
      stubManager({
        annotateStderrWithSandboxFailures: (_id, stderr) => `${stderr}<explained>`
      })
    );
    const result = await runner.run(options({ command: 'echo boom >&2' }));
    expect(result.stderr).toBe('boom\n<explained>');
  });
});

/**
 * The security property itself. Everything above tests plumbing; this asserts
 * the kernel actually refuses the write. Skipped where the platform cannot
 * sandbox rather than silently passing.
 */
const status = await probeSandbox();

describe.skipIf(!status.supported)('sandbox confinement (real)', () => {
  it('blocks a write outside the workspace and allows one inside', async () => {
    const runner = new SandboxedCommandRunner(
      { allowWrite: [workspace], denyRead: [], allowedDomains: [] },
      process.env
    );
    const escapePath = join(outside, 'escaped.txt');

    const blocked = await runner.run(
      options({ command: `echo pwned > ${JSON.stringify(escapePath)}` })
    );
    expect(blocked.exitCode).not.toBe(0);
    await expect(readFile(escapePath, 'utf8')).rejects.toThrow();

    const allowed = await runner.run(
      options({ command: `echo fine > ${JSON.stringify(join(workspace, 'ok.txt'))}` })
    );
    expect(allowed.exitCode).toBe(0);
    expect(await readFile(join(workspace, 'ok.txt'), 'utf8')).toBe('fine\n');
  }, 60_000);

  it('keeps the API key out of the sandboxed child', async () => {
    const runner = new SandboxedCommandRunner(
      { allowWrite: [workspace], denyRead: [], allowedDomains: [] },
      { ...process.env, ANTHROPIC_API_KEY: 'sk-must-not-leak' }
    );
    const result = await runner.run(options({ command: 'echo "${ANTHROPIC_API_KEY:-absent}"' }));
    expect(result.stdout.trim()).toBe('absent');
  }, 60_000);
});
