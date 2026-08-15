import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isHarnessError } from '../errors/index.ts';
import { resolveWorkspacePath } from './guard.ts';

let outer: string;
let root: string;

beforeEach(async () => {
  outer = await mkdtemp(join(tmpdir(), 'harness-guard-'));
  root = join(outer, 'work');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export {}\n', 'utf8');
  await writeFile(join(outer, 'secret.txt'), 'outside\n', 'utf8');
  // Sibling directory sharing the root as a string prefix.
  await mkdir(join(outer, 'work-evil'), { recursive: true });
  await writeFile(join(outer, 'work-evil', 'payload.txt'), 'evil\n', 'utf8');
});

afterEach(async () => {
  await rm(outer, { recursive: true, force: true });
});

async function deniedFor(candidate: string): Promise<boolean> {
  try {
    await resolveWorkspacePath(root, candidate);
    return false;
  } catch (error) {
    return isHarnessError(error) && error.code === 'permission_denied';
  }
}

describe('resolveWorkspacePath', () => {
  it('resolves relative, dot-prefixed, and absolute-inside paths', async () => {
    expect((await resolveWorkspacePath(root, 'src/a.ts')).relative).toBe(join('src', 'a.ts'));
    expect((await resolveWorkspacePath(root, './src/a.ts')).relative).toBe(join('src', 'a.ts'));
    expect((await resolveWorkspacePath(root, join(root, 'src/a.ts'))).relative).toBe(
      join('src', 'a.ts')
    );
    expect((await resolveWorkspacePath(root, '.')).relative).toBe('.');
  });

  it('resolves non-existent paths inside the workspace (for future writes)', async () => {
    const resolved = await resolveWorkspacePath(root, 'src/new/dir/file.ts');
    expect(resolved.relative).toBe(join('src', 'new', 'dir', 'file.ts'));
  });

  it('normalizes redundant segments that stay inside', async () => {
    expect((await resolveWorkspacePath(root, 'src/../src/./a.ts')).relative).toBe(
      join('src', 'a.ts')
    );
  });

  it.each([
    ['../secret.txt', 'relative traversal'],
    ['src/../../secret.txt', 'nested traversal'],
    ['src/../../../../../../etc/hosts', 'deep traversal'],
    ['/etc/hosts', 'absolute outside']
  ])('denies %s (%s)', async (candidate) => {
    expect(await deniedFor(candidate)).toBe(true);
  });

  it('denies the string-prefix sibling directory (segment boundary)', async () => {
    expect(await deniedFor(join(outer, 'work-evil', 'payload.txt'))).toBe(true);
  });

  it('denies symlinks that point outside the workspace', async () => {
    await symlink(join(outer, 'secret.txt'), join(root, 'sneaky.txt'));
    expect(await deniedFor('sneaky.txt')).toBe(true);
  });

  it('denies traversal through an in-workspace symlinked directory', async () => {
    await symlink(outer, join(root, 'updir'));
    expect(await deniedFor('updir/secret.txt')).toBe(true);
  });

  it('denies null bytes', async () => {
    expect(await deniedFor('src/a.ts\0.png')).toBe(true);
  });

  it('follows symlinks that stay inside the workspace', async () => {
    await symlink(join(root, 'src', 'a.ts'), join(root, 'alias.ts'));
    const resolved = await resolveWorkspacePath(root, 'alias.ts');
    expect(resolved.relative).toBe(join('src', 'a.ts'));
  });
});
