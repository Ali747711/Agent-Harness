import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DirectCommandRunner } from '../../exec/direct.ts';
import { resolveWorkspacePath } from '../../permissions/guard.ts';
import type { ToolContext } from '../tool.ts';
import { FileTracker } from '../tracker.ts';
import { editTool } from './edit.ts';
import { readTool } from './read.ts';
import { writeTool } from './write.ts';

let workspace: string;
let ctx: ToolContext;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'harness-mutate-'));
  // One shared context per test: the tracker must persist across read → edit.
  ctx = {
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    resolvePath: (candidate) => resolveWorkspacePath(workspace, candidate),
    files: new FileTracker(),
    runner: new DirectCommandRunner()
  };
  await writeFile(join(workspace, 'existing.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function noTempFiles(): Promise<void> {
  const entries = await readdir(workspace, { recursive: true });
  expect(entries.filter((name) => String(name).includes('.harness-tmp'))).toEqual([]);
}

describe('write tool', () => {
  it('creates new files with parent directories, atomically', async () => {
    const result = await writeTool.execute(
      { path: 'deep/new/dir/file.txt', content: 'hello\nworld\n' },
      ctx
    );
    expect(result).toMatchObject({ ok: true, metadata: { created: true, lines: 3 } });
    expect(await readFile(join(workspace, 'deep/new/dir/file.txt'), 'utf8')).toBe('hello\nworld\n');
    await noTempFiles();
  });

  it('refuses to overwrite a file that was not read this session', async () => {
    const result = await writeTool.execute({ path: 'existing.txt', content: 'clobber' }, ctx);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('not read this session');
    }
    expect(await readFile(join(workspace, 'existing.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });

  it('overwrites after a read, and a write unlocks subsequent edits', async () => {
    await readTool.execute({ path: 'existing.txt' }, ctx);
    const result = await writeTool.execute({ path: 'existing.txt', content: 'rewritten\n' }, ctx);
    expect(result).toMatchObject({ ok: true, metadata: { created: false } });

    // The write recorded the new state — an edit needs no re-read.
    const edit = await editTool.execute(
      { path: 'existing.txt', old_string: 'rewritten', new_string: 'edited' },
      ctx
    );
    expect(edit).toMatchObject({ ok: true });
    expect(await readFile(join(workspace, 'existing.txt'), 'utf8')).toBe('edited\n');
  });

  it('detects external modification between read and write (stale)', async () => {
    await readTool.execute({ path: 'existing.txt' }, ctx);
    await writeFile(join(workspace, 'existing.txt'), 'changed externally\n', 'utf8');

    const result = await writeTool.execute({ path: 'existing.txt', content: 'clobber' }, ctx);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('changed on disk');
    }
    expect(await readFile(join(workspace, 'existing.txt'), 'utf8')).toBe('changed externally\n');
  });

  it('fails legibly when a parent path is a file, leaving no artifacts', async () => {
    const result = await writeTool.execute({ path: 'existing.txt/child.txt', content: 'x' }, ctx);
    expect(result).toMatchObject({ ok: false });
    await noTempFiles();
  });

  it('denies escapes', async () => {
    const result = await writeTool.execute({ path: '../escape.txt', content: 'x' }, ctx);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('outside the workspace');
    }
  });
});

describe('edit tool', () => {
  it('replaces a unique match exactly', async () => {
    await readTool.execute({ path: 'existing.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'existing.txt', old_string: 'beta', new_string: 'BETA' },
      ctx
    );
    expect(result).toMatchObject({ ok: true, metadata: { replacements: 1 } });
    expect(await readFile(join(workspace, 'existing.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');
    await noTempFiles();
  });

  it('requires a read first', async () => {
    const result = await editTool.execute(
      { path: 'existing.txt', old_string: 'beta', new_string: 'x' },
      ctx
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('not read this session');
    }
  });

  it('rejects stale files changed since the read', async () => {
    await readTool.execute({ path: 'existing.txt' }, ctx);
    await writeFile(join(workspace, 'existing.txt'), 'alpha\nbeta\ngamma\nextra\n', 'utf8');
    const result = await editTool.execute(
      { path: 'existing.txt', old_string: 'beta', new_string: 'x' },
      ctx
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('changed on disk');
    }
  });

  it('errors on zero matches with an exactness hint', async () => {
    await readTool.execute({ path: 'existing.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'existing.txt', old_string: 'delta', new_string: 'x' },
      ctx
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.hint).toContain('exact');
    }
  });

  it('errors on ambiguous matches, naming the count', async () => {
    await writeFile(join(workspace, 'dup.txt'), 'x\nx\nx\n', 'utf8');
    await readTool.execute({ path: 'dup.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'dup.txt', old_string: 'x', new_string: 'y' },
      ctx
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('3 places');
      expect(result.error.hint).toContain('replace_all');
    }
  });

  it('replace_all replaces every occurrence and reports the count', async () => {
    await writeFile(join(workspace, 'dup.txt'), 'x\nx\nx\n', 'utf8');
    await readTool.execute({ path: 'dup.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true },
      ctx
    );
    expect(result).toMatchObject({ ok: true, metadata: { replacements: 3 } });
    expect(await readFile(join(workspace, 'dup.txt'), 'utf8')).toBe('y\ny\ny\n');
  });

  it('supports consecutive edits without re-reading', async () => {
    await readTool.execute({ path: 'existing.txt' }, ctx);
    await editTool.execute({ path: 'existing.txt', old_string: 'alpha', new_string: 'A' }, ctx);
    const second = await editTool.execute(
      { path: 'existing.txt', old_string: 'gamma', new_string: 'G' },
      ctx
    );
    expect(second).toMatchObject({ ok: true });
    expect(await readFile(join(workspace, 'existing.txt'), 'utf8')).toBe('A\nbeta\nG\n');
  });

  it('preserves CRLF line endings and trailing-newline state', async () => {
    await writeFile(join(workspace, 'crlf.txt'), 'one\r\ntwo\r\nthree', 'utf8');
    await readTool.execute({ path: 'crlf.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'crlf.txt', old_string: 'two', new_string: 'TWO' },
      ctx
    );
    expect(result).toMatchObject({ ok: true });
    // \r\n intact everywhere, and still no trailing newline.
    expect(await readFile(join(workspace, 'crlf.txt'), 'utf8')).toBe('one\r\nTWO\r\nthree');
  });

  it('handles unicode content', async () => {
    await writeFile(join(workspace, 'uni.txt'), 'héllo wörld 🚀\n', 'utf8');
    await readTool.execute({ path: 'uni.txt' }, ctx);
    const result = await editTool.execute(
      { path: 'uni.txt', old_string: 'wörld 🚀', new_string: 'wörld 🌍' },
      ctx
    );
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(workspace, 'uni.txt'), 'utf8')).toBe('héllo wörld 🌍\n');
  });

  it('rejects identical old/new strings and missing files', async () => {
    const same = await editTool.execute(
      { path: 'existing.txt', old_string: 'x', new_string: 'x' },
      ctx
    );
    expect(same).toMatchObject({ ok: false });

    const missing = await editTool.execute(
      { path: 'nope.txt', old_string: 'a', new_string: 'b' },
      ctx
    );
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) {
      expect(missing.error.hint).toContain('write');
    }
  });
});
