import { describe, expect, it } from 'vitest';

import { CLEAR_SCREEN, clearScreen } from './screen.ts';

function fakeStream(isTTY: boolean | undefined) {
  const written: string[] = [];
  return {
    stream: {
      ...(isTTY !== undefined && { isTTY }),
      write: (data: string) => {
        written.push(data);
        return true;
      }
    },
    written
  };
}

describe('clearScreen', () => {
  it('homes the cursor on a real terminal', () => {
    const { stream, written } = fakeStream(true);
    expect(clearScreen(stream)).toBe(true);
    expect(written).toEqual([CLEAR_SCREEN]);
  });

  it('preserves scrollback — ctrl-l does not discard terminal history', () => {
    expect(CLEAR_SCREEN).not.toContain('3J');
    expect(CLEAR_SCREEN).toBe('\u001B[2J\u001B[H');
  });

  it('writes nothing when stdout is piped or redirected', () => {
    for (const isTTY of [false, undefined]) {
      const { stream, written } = fakeStream(isTTY);
      expect(clearScreen(stream)).toBe(false);
      expect(written).toEqual([]);
    }
  });
});
