import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Current branch for the header, read straight from .git/HEAD — no subprocess,
 * no dependency. Deliberately UI-only: the branch changes during a session and
 * must never enter the frozen system prompt (ADR-0008).
 */
export async function readGitBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const head = (await readFile(join(workspaceRoot, '.git', 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    // Detached HEAD: show the short sha instead of a branch name.
    return ref?.[1] ?? (head.length >= 7 ? head.slice(0, 7) : null);
  } catch {
    return null;
  }
}
