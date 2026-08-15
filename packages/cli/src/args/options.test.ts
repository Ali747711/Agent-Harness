import { describe, expect, it } from 'vitest';

import { flagsFromCli } from './options.ts';

describe('flagsFromCli', () => {
  it('maps only provided flags', () => {
    expect(flagsFromCli({})).toEqual({});
    expect(flagsFromCli({ model: 'claude-sonnet-5', effort: 'xhigh' })).toEqual({
      model: 'claude-sonnet-5',
      effort: 'xhigh'
    });
  });

  it('converts numeric flags', () => {
    expect(flagsFromCli({ maxTokens: '4096', maxTurns: '5' })).toEqual({
      maxTokens: 4096,
      maxTurns: 5
    });
  });

  it('passes invalid numbers through for config-layer rejection with flag origin', () => {
    const flags = flagsFromCli({ maxTokens: 'lots' });
    expect(Number.isNaN(flags.maxTokens)).toBe(true);
  });

  it('never invents keys (print/cwd/outputFormat are not config)', () => {
    expect(flagsFromCli({ print: 'hi', cwd: '/x', outputFormat: 'jsonl' })).toEqual({});
  });
});
