import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../config/schema.ts';
import { DirectCommandRunner } from './direct.ts';
import type { CommandRunner } from './runner.ts';
import { SandboxedCommandRunner, type SandboxPolicy } from './sandbox.ts';

/**
 * Turns config into a concrete sandbox policy. Pure and separately testable —
 * the policy is the security boundary, so it must be assertable without
 * spawning anything.
 */

/**
 * Credential stores a project's build commands have no business reading.
 *
 * Deliberately limited to paths OUTSIDE the workspace. Denying in-workspace
 * secrets (`**\/.env`) would only half-work anyway: the sandbox governs bash,
 * while the `read` tool goes through WorkspaceGuard, so `cat .env` would fail
 * while `read .env` succeeded — an inconsistency that teaches the wrong model
 * of what is protected.
 */
export function credentialDenyPaths(home: string = homedir()): string[] {
  return [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.kube'),
    join(home, '.docker'),
    join(home, '.netrc'),
    join(home, '.config', 'gh'),
    join(home, '.config', 'gcloud')
  ];
}

export function sandboxPolicyFor(
  workspaceRoot: string,
  config: Config['sandbox'],
  env: { home?: string; tmp?: string } = {}
): SandboxPolicy {
  const home = env.home ?? homedir();
  return {
    // The workspace is the point of the sandbox; temp is added because build
    // tools legitimately need $TMPDIR and failing there looks like a bug in
    // the user's toolchain rather than a policy decision.
    allowWrite: [workspaceRoot, env.tmp ?? tmpdir(), ...config.allowWrite],
    denyRead: [...credentialDenyPaths(home), ...config.denyRead],
    allowedDomains: [...config.allowedDomains]
  };
}

/**
 * The single place that decides whether bash is confined. Callers pass config;
 * nothing else in the codebase should be constructing runners.
 */
export function createCommandRunner(
  workspaceRoot: string,
  config: Config,
  baseEnv: NodeJS.ProcessEnv = process.env
): CommandRunner {
  return config.sandbox.enabled
    ? new SandboxedCommandRunner(sandboxPolicyFor(workspaceRoot, config.sandbox), baseEnv)
    : new DirectCommandRunner(baseEnv);
}
