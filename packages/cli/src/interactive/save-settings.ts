import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SavedSettings } from './controller.ts';

/**
 * Persists what /config save changes, into the PROJECT config
 * (<workspace>/.harness/config.json).
 *
 * Merges rather than overwrites: the file is the user's, and it may hold keys
 * this command knows nothing about (sandbox, permissions rules, memoryFiles).
 * Writing only the three settings it owns keeps it from silently deleting the
 * rest.
 */
export function settingsWriter(workspaceRoot: string) {
  return async (settings: SavedSettings): Promise<string> => {
    const path = join(workspaceRoot, '.harness', 'config.json');

    let existing: Record<string, unknown> = {};
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (error) {
      // A missing file is the normal first-save case. Anything else — malformed
      // JSON especially — must NOT be silently replaced with a fresh object;
      // that would destroy a config the user only mistyped.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new Error(`refusing to overwrite unreadable config at ${path}: ${String(error)}`);
      }
    }

    const merged = {
      ...existing,
      model: settings.model,
      effort: settings.effort,
      permissionMode: settings.permissionMode
    };

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return path;
  };
}
