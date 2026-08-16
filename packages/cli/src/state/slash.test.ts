import { describe, expect, it } from 'vitest';

import { completions, isKnownCommand, parseSlash } from './slash.ts';

describe('slash commands', () => {
  it('parses a command and its arguments', () => {
    expect(parseSlash('/help')).toEqual({ name: 'help', args: '' });
    expect(parseSlash('  /model  opus  ')).toEqual({ name: 'model', args: 'opus' });
  });

  it('is not a command when there is no leading slash or no name', () => {
    expect(parseSlash('help')).toBeNull();
    expect(parseSlash('/ nope')).toBeNull();
    expect(parseSlash('what about / this')).toBeNull();
  });

  it('recognises only known commands', () => {
    expect(isKnownCommand('clear')).toBe(true);
    expect(isKnownCommand('teleport')).toBe(false);
  });

  it('suggests completions while typing and stops once a space is typed', () => {
    expect(completions('/c').map((command) => command.name)).toEqual(['clear', 'cost', 'config']);
    // Argument-taking commands still complete on the name alone.
    expect(completions('/e').map((command) => command.name)).toEqual(['effort', 'exit']);
    expect(completions('/').length).toBeGreaterThan(3);
    expect(completions('/clear ')).toEqual([]);
    expect(completions('not a command')).toEqual([]);
    expect(completions('/zzz')).toEqual([]);
  });
});
