import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Transcript layout (ADR-0004): ~/.harness/projects/<slug>-<hash>/<id>.jsonl —
 * out-of-repo so transcripts are never accidentally committed. The hash keeps
 * same-named projects in different locations from colliding.
 */
export function projectSlug(workspaceRoot: string): string {
  const name = basename(workspaceRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const hash = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 8);
  return `${name.length > 0 ? name : 'project'}-${hash}`;
}

export function harnessHomeDir(): string {
  return join(homedir(), '.harness');
}

export function projectSessionsDir(workspaceRoot: string, baseDir?: string): string {
  const base = baseDir ?? harnessHomeDir();
  return join(base, 'projects', projectSlug(workspaceRoot));
}

/** The derived index (ADR-0004) — always rebuildable from the JSONL files. */
export function indexDbPath(baseDir?: string): string {
  return join(baseDir ?? harnessHomeDir(), 'index.db');
}

export function sessionFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.jsonl`);
}
