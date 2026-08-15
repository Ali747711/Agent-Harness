import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { EnvironmentSnapshot } from './system-prompt.ts';

/**
 * Probe the environment ONCE at session start (ADR-0008). Deliberately coarse:
 * date without a clock time, a boolean for git rather than the branch name.
 * Anything finer-grained changes between turns and would invalidate the cached
 * prefix — if you need live git state, put it in a message, not the system
 * prompt.
 */
export async function probeEnvironment(workspaceRoot: string): Promise<EnvironmentSnapshot> {
  const isGitRepo = await stat(join(workspaceRoot, '.git'))
    .then(() => true)
    .catch(() => false);
  return {
    workspaceRoot,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    isGitRepo
  };
}
