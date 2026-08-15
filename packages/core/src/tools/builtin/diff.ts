import { structuredPatch } from 'diff';

/**
 * Compact unified diff for tool results (TUI step). Produced in core because
 * the tool is the only thing that knows both the before and after states;
 * clients just render the string.
 *
 * Format is intentionally plain text — `-`/`+`/` ` prefixes and `@@` hunk
 * headers — so headless output stays readable and the TUI can colour it.
 */
export interface DiffResult {
  text: string;
  added: number;
  removed: number;
  /** True when hunks were dropped to respect the line budget. */
  truncated: boolean;
}

const CONTEXT_LINES = 2;
const MAX_DIFF_LINES = 60;

export function renderDiff(before: string, after: string, path: string): DiffResult {
  const patch = structuredPatch(path, path, before, after, '', '', { context: CONTEXT_LINES });

  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;

  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added += 1;
      } else if (line.startsWith('-')) {
        removed += 1;
      }
    }
  }

  outer: for (const hunk of patch.hunks) {
    if (lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (lines.length >= MAX_DIFF_LINES) {
        truncated = true;
        break outer;
      }
      // `diff` emits a bare '\' marker line for no-newline-at-eof; drop it.
      if (!line.startsWith('\\')) {
        lines.push(line);
      }
    }
  }

  if (truncated) {
    lines.push(`… diff truncated (${added} added, ${removed} removed in total)`);
  }

  return { text: lines.join('\n'), added, removed, truncated };
}

/** "+3 −1" style badge for a tool title. */
export function diffBadge(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`+${added}`);
  }
  if (removed > 0) {
    parts.push(`−${removed}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'no change';
}
