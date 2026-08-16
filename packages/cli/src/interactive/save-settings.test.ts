import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settingsWriter } from './save-settings.ts';

let workspace: string;
const settings = {
  model: 'claude-sonnet-5',
  effort: 'low' as const,
  permissionMode: 'default' as const
};

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'harness-save-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('settingsWriter', () => {
  it('creates the config file when none exists', async () => {
    const path = await settingsWriter(workspace)(settings);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      model: 'claude-sonnet-5',
      effort: 'low',
      permissionMode: 'default'
    });
  });

  it('keeps keys it does not own', async () => {
    // The file is the user's; /config save owns three settings, not the file.
    await mkdir(join(workspace, '.harness'), { recursive: true });
    await writeFile(
      join(workspace, '.harness', 'config.json'),
      JSON.stringify({ sandbox: { enabled: true }, memoryFiles: ['NOTES.md'], effort: 'max' }),
      'utf8'
    );

    const path = await settingsWriter(workspace)(settings);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      sandbox: { enabled: true },
      memoryFiles: ['NOTES.md'],
      model: 'claude-sonnet-5',
      effort: 'low',
      permissionMode: 'default'
    });
  });

  it('refuses to clobber a config it cannot parse', async () => {
    // A typo in JSON must not cost the user their whole config.
    await mkdir(join(workspace, '.harness'), { recursive: true });
    const path = join(workspace, '.harness', 'config.json');
    await writeFile(path, '{ "model": "x",, }', 'utf8');

    await expect(settingsWriter(workspace)(settings)).rejects.toThrow(/refusing to overwrite/);
    expect(await readFile(path, 'utf8')).toBe('{ "model": "x",, }');
  });
});
