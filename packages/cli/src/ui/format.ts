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
