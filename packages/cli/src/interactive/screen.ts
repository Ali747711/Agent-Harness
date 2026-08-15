/**
 * Terminal screen control for session start.
 *
 * A session should begin at the top of a clean screen, the way ctrl-l leaves
 * one — otherwise the header renders under whatever the shell last printed and
 * the first frame reads as a continuation of that noise.
 */

/** Erase the visible screen (2J), then home the cursor (H). */
export const CLEAR_SCREEN = '\u001B[2J\u001B[H';

export interface WritableTty {
  isTTY?: boolean | undefined;
  write(data: string): unknown;
}

/**
 * Scrollback is deliberately left intact (no `3J`): ctrl-l does not throw away
 * terminal history, and the user's earlier output is not ours to destroy.
 * Returns whether anything was written, so a piped or redirected stdout does
 * not get escape codes in its stream.
 */
export function clearScreen(stream: WritableTty): boolean {
  if (stream.isTTY !== true) {
    return false;
  }
  stream.write(CLEAR_SCREEN);
  return true;
}
