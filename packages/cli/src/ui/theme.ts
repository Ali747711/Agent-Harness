/**
 * Single source of visual truth for the TUI. Colours are the 16 ANSI names
 * rather than hex, so the terminal's own palette (and the user's light/dark
 * choice) is respected instead of fought.
 */
export const theme = {
  color: {
    user: 'cyan',
    assistant: 'white',
    thinking: 'gray',
    tool: 'blue',
    toolRunning: 'yellow',
    ok: 'green',
    error: 'red',
    warning: 'yellow',
    permission: 'yellow',
    muted: 'gray',
    added: 'green',
    removed: 'red',
    hunk: 'cyan',
    accent: 'magenta'
  },
  label: {
    user: 'you',
    assistant: 'harness',
    thinking: 'thinking'
  },
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  spinnerIntervalMs: 80
} as const;

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function compactTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  return `${(count / 1000).toFixed(1)}k`;
}
