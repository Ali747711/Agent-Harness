import { readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Project memory loader (ADR-0009): an ordered filename list, discovered
 * hierarchically. Parent directories are searched too, and their files are
 * emitted FIRST so the workspace's own memory speaks last and wins on
 * conflicts.
 *
 * Loaded ONCE at session start and frozen into the system prompt (ADR-0008),
 * so nothing here may run per turn.
 */
export interface MemoryFile {
  /** Path relative to the workspace root, or absolute when above it. */
  label: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface LoadMemoryOptions {
  workspaceRoot: string;
  /** Ordered filenames, e.g. ['HARNESS.md', 'AGENTS.md', 'CLAUDE.md']. */
  filenames: readonly string[];
  /** How many parent directories above the workspace to search. */
  parentLevels?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  readTextFile?: (path: string) => Promise<string | null>;
}

const DEFAULT_MAX_BYTES_PER_FILE = 32_768;
const DEFAULT_MAX_TOTAL_BYTES = 65_536;
const DEFAULT_PARENT_LEVELS = 3;

async function defaultReadTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Missing or unreadable memory is not an error — memory is optional.
    return null;
  }
}

function directoriesToSearch(workspaceRoot: string, parentLevels: number): string[] {
  const dirs = [workspaceRoot];
  let current = workspaceRoot;
  for (let level = 0; level < parentLevels; level += 1) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    dirs.push(parent);
    current = parent;
  }
  // Outermost first: general context before project-specific overrides.
  return dirs.reverse();
}

export async function loadProjectMemory(options: LoadMemoryOptions): Promise<MemoryFile[]> {
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const maxPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const dirs = directoriesToSearch(
    options.workspaceRoot,
    options.parentLevels ?? DEFAULT_PARENT_LEVELS
  );

  const loaded: MemoryFile[] = [];
  let total = 0;

  for (const dir of dirs) {
    for (const filename of options.filenames) {
      if (total >= maxTotal) {
        return loaded;
      }
      const path = join(dir, filename);
      const raw = await readTextFile(path);
      if (raw === null || raw.trim().length === 0) {
        continue;
      }

      const remaining = maxTotal - total;
      const budget = Math.min(maxPerFile, remaining);
      const truncated = Buffer.byteLength(raw, 'utf8') > budget;
      const content = truncated
        ? `${raw.slice(0, budget)}\n… [memory file truncated at ${budget} bytes]`
        : raw;
      const bytes = Buffer.byteLength(content, 'utf8');
      total += bytes;

      const rel = relative(options.workspaceRoot, path);
      loaded.push({
        label: rel.startsWith('..') ? path : rel.split(sep).join('/'),
        content,
        bytes,
        truncated
      });
    }
  }

  return loaded;
}
