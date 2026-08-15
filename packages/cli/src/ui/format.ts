import { homedir } from 'node:os';

/**
 * Display formatting for a width-constrained terminal. Pure functions so the
 * layout can be reasoned about (and tested) without rendering.
 */

/** Context windows by model family; used for the "% ctx" footer reading. */
const MODEL_CONTEXT: ReadonlyArray<{ match: RegExp; tokens: number }> = [
  { match: /^claude-(opus-5|fable-5|mythos-5|sonnet-5)/, tokens: 1_000_000 },
  { match: /^claude-(opus|sonnet)-4/, tokens: 200_000 },
  { match: /^claude-haiku/, tokens: 200_000 }
];

export function contextWindow(model: string): number {
  return MODEL_CONTEXT.find((entry) => entry.match.test(model))?.tokens ?? 200_000;
}

export function contextPercent(promptTokens: number, model: string): number {
  return Math.min(100, Math.round((promptTokens / contextWindow(model)) * 100));
}

/** ~/projects/app rather than /Users/someone/projects/app. */
export function tildePath(path: string, home = homedir()): string {
  return home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Keep both ends of a path readable: src/…/deep/file.ts */
export function middleEllipsis(text: string, max: number): string {
  if (max <= 1 || text.length <= max) {
    return text;
  }
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${tail === 0 ? '' : text.slice(-tail)}`;
}

export function compactTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

/** Cost is meaningless below a cent at 4dp; keep the column narrow. */
export function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * Tool titles read "Write src/x.ts" but the row already has a `write` column,
 * so the verb is pure echo. Only strip it when something remains.
 */
export function stripToolVerb(tool: string, title: string): string {
  const [first, ...rest] = title.split(' ');
  return first !== undefined && rest.length > 0 && first.toLowerCase() === tool.toLowerCase()
    ? rest.join(' ')
    : title;
}

/**
 * Split a tool call into the two halves of its one-line row:
 *   ✓ write  tech-stack.html · +76 −0 · 2.6s
 *            └ label           └ detail
 * write/edit summaries lead with the same path as the title; repeating it
 * costs the columns that the actual result needs.
 */
export function toolRowText(line: { tool: string; title: string; summary: string }): {
  label: string;
  detail: string | null;
} {
  const stripped = stripToolVerb(line.tool, line.title).trim();
  // A call that fails input validation never gets a real title, so it arrives
  // titled after its own tool. The row already has that column.
  const label = stripped.toLowerCase() === line.tool.toLowerCase() ? '' : stripped;
  const summary = line.summary.trim();
  if (summary === '') {
    return { label, detail: null };
  }
  if (label !== '' && summary.startsWith(label)) {
    const rest = summary.slice(label.length).trim();
    return { label, detail: rest === '' ? null : rest };
  }
  return { label, detail: summary };
}

/**
 * How much of a patch is worth showing inline.
 *
 * An excerpt earns its space when it shows a CHANGE — something replaced that
 * you want to eyeball. A long run of pure additions is new content, not a
 * change: the row's `+76` badge already says everything the first 16 lines of
 * it would, so nothing is shown at all.
 */
export function diffPreview(
  text: string,
  max: number
): { lines: string[]; hidden: number; collapsed: boolean } {
  const all = text.split('\n');
  if (all.length <= max) {
    return { lines: all, hidden: 0, collapsed: false };
  }
  if (!all.some((line) => line.startsWith('-'))) {
    return { lines: [], hidden: all.length, collapsed: true };
  }
  return { lines: all.slice(0, max), hidden: all.length - max, collapsed: false };
}

/** Higher priority survives a narrow terminal; the lowest is dropped first. */
export interface Segment {
  text: string;
  priority: number;
}

/**
 * Join what fits. A status bar that wraps is worse than one that says less, so
 * segments are shed by priority until the line clears the width budget.
 */
export function fitSegments(segments: readonly Segment[], max: number, separator = ' · '): string {
  const join = (list: readonly Segment[]): string =>
    list.map((segment) => segment.text).join(separator);

  let kept = segments.filter((segment) => segment.text !== '');
  while (kept.length > 1 && join(kept).length > max) {
    let weakest = 0;
    for (let index = 1; index < kept.length; index += 1) {
      const candidate = kept[index];
      const current = kept[weakest];
      if (
        candidate !== undefined &&
        current !== undefined &&
        candidate.priority < current.priority
      ) {
        weakest = index;
      }
    }
    kept = kept.filter((_, index) => index !== weakest);
  }
  return join(kept);
}
