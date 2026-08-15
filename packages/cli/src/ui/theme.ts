/**
 * Single source of visual truth: a calm dark palette — neutral greys for
 * chrome, one violet accent for focus, and colour reserved for state that
 * matters (success / warning / error). Colours are ANSI names so the user's
 * own terminal palette wins.
 */
export const theme = {
  color: {
    /** Primary reading text. */
    text: 'white',
    /** Chrome, separators, secondary metadata. */
    muted: 'gray',
    /** Focus, prompts, code. One accent only. */
    accent: 'magenta',
    ok: 'green',
    warning: 'yellow',
    error: 'red',
    running: 'yellow',
    diffAdd: 'green',
    diffRemove: 'red',
    diffHunk: 'cyan'
  },
  glyph: {
    prompt: '›',
    bullet: '·',
    ok: '✓',
    error: '✗',
    running: '●',
    mode: '●',
    separator: '─'
  },
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  spinnerIntervalMs: 80
} as const;

export type PermissionModeName = 'default' | 'acceptEdits' | 'bypass';

/** Footer mode descriptor: colour carries the risk level at a glance. */
export const MODE_DISPLAY: Record<
  PermissionModeName,
  { label: string; detail: string; color: string }
> = {
  // Colour tracks risk, not activity: neutral while everything is gated,
  // warning once writes land unattended, red when nothing is.
  default: { label: 'ask', detail: 'writes & commands', color: theme.color.muted },
  acceptEdits: {
    label: 'auto-edit',
    detail: 'writes allowed · commands ask',
    color: theme.color.warning
  },
  bypass: { label: 'bypass', detail: 'nothing is gated', color: theme.color.error }
};
