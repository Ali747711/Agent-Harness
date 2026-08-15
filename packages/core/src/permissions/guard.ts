import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { HarnessError } from '../errors/index.ts';

/**
 * WorkspaceGuard (ADR-0006): canonicalize a model-supplied path and reject
 * anything that escapes the workspace root. Non-bypassable — no permission
 * rule can override it, and tools re-resolve through it at execute time
 * (closing plan→execute TOCTOU). The step-8 PermissionEngine layers rules and
 * modes on top; this module is the confinement primitive.
 *
 * Canonicalization: realpath the nearest EXISTING ancestor (resolves every
 * symlink that exists), then re-join the not-yet-existing remainder — which
 * cannot contain symlinks and, after lexical normalization, cannot contain
 * `..`. Containment is checked at path-segment boundaries so `/work` never
 * matches `/workspace-evil`.
 */
export interface ResolvedPath {
  /** Fully canonicalized absolute path. */
  absolute: string;
  /** Relative to the canonical workspace root ('.' for the root itself). */
  relative: string;
}

function denied(candidate: string, reason: string): HarnessError {
  return new HarnessError(
    'permission_denied',
    `path outside the workspace: ${candidate} (${reason})`,
    { recoverable: false }
  );
}

async function canonicalize(absolutePath: string): Promise<string> {
  // Walk up to the nearest existing ancestor, realpath it, re-join the rest.
  let existing = absolutePath;
  let remainder = '';
  while (true) {
    try {
      const real = await realpath(existing);
      return remainder === '' ? real : join(real, remainder);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        // Filesystem root claimed not to exist — treat the path as-is.
        return remainder === '' ? existing : join(existing, remainder);
      }
      remainder =
        remainder === ''
          ? existing.slice(parent.length + 1)
          : join(existing.slice(parent.length + 1), remainder);
      existing = parent;
    }
  }
}

export async function resolveWorkspacePath(
  workspaceRoot: string,
  candidate: string
): Promise<ResolvedPath> {
  if (candidate.includes('\0')) {
    throw denied(JSON.stringify(candidate), 'null byte');
  }

  const rootCanonical = await realpath(workspaceRoot).catch(() => {
    throw new HarnessError('internal', `workspace root does not exist: ${workspaceRoot}`);
  });

  const absoluteInput = isAbsolute(candidate)
    ? normalize(candidate)
    : resolve(rootCanonical, candidate);
  const absolute = await canonicalize(absoluteInput);

  const contained = absolute === rootCanonical || absolute.startsWith(rootCanonical + sep);
  if (!contained) {
    throw denied(candidate, `resolves to ${absolute}`);
  }

  const rel = relative(rootCanonical, absolute);
  return { absolute, relative: rel === '' ? '.' : rel };
}
