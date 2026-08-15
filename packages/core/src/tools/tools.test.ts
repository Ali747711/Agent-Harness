import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DirectCommandRunner } from '../exec/direct.ts';
import { resolveWorkspacePath } from '../permissions/guard.ts';
import { globTool } from './builtin/glob.ts';
import { readTool } from './builtin/read.ts';
import { ToolRegistry } from './registry.ts';
import { defineTool, type ToolContext } from './tool.ts';
import { FileTracker } from './tracker.ts';

let workspace: string;

function ctx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    signal: new AbortController().signal,
    resolvePath: (candidate) => resolveWorkspacePath(root, candidate),
    files: new FileTracker(),
    runner: new DirectCommandRunner()
  };
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'harness-tools-'));
  await mkdir(join(workspace, 'src', 'deep'), { recursive: true });
  await writeFile(join(workspace, 'src', 'one.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  await writeFile(join(workspace, 'src', 'deep', 'two.ts'), 'export {};\n', 'utf8');
  await writeFile(join(workspace, 'notes.md'), '# notes\n', 'utf8');
  // Deterministic mtimes: two.ts newest, one.ts oldest.
  await utimes(join(workspace, 'src', 'one.ts'), new Date(1000000), new Date(1000000));
  await utimes(join(workspace, 'src', 'deep', 'two.ts'), new Date(2000000), new Date(2000000));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('ToolRegistry', () => {
  const fake = (name: string) =>
    defineTool<{ x: string }>({
      name,
      description: `tool ${name}`,
      schema: z.strictObject({ x: z.string() }),
      readOnly: true,
      renderTitle: () => name,
      plan: () => ({ tool: name, title: name, effects: [] }),
      execute: () => Promise.resolve({ ok: true, content: 'ok', summary: 'ok' })
    });

  it('rejects duplicate registrations', () => {
    const registry = new ToolRegistry().register(fake('a'));
    expect(() => registry.register(fake('a'))).toThrowError(/duplicate/);
  });

  it('emits sorted, strict, byte-stable wire specs regardless of registration order', () => {
    const first = new ToolRegistry().register(fake('zeta')).register(fake('alpha'));
    const second = new ToolRegistry().register(fake('alpha')).register(fake('zeta'));

    const specs = first.toWireSpecs();
    expect(specs.map((spec) => spec.name)).toEqual(['alpha', 'zeta']);
    expect(JSON.stringify(specs)).toBe(JSON.stringify(second.toWireSpecs()));

    const schema = specs[0]?.inputSchema as Record<string, unknown>;
    expect(specs[0]?.strict).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe('object');
  });
});

describe('read tool', () => {
  it('returns line-numbered content', async () => {
    const result = await readTool.execute({ path: 'src/one.ts' }, ctx(workspace));
    expect(result).toMatchObject({ ok: true, summary: 'read 2 of 2 lines' });
    if (result.ok) {
      expect(result.content).toBe('1→const a = 1;\n2→const b = 2;');
      expect(result.metadata).toMatchObject({ lines: 2 });
      expect(result.metadata?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('pages with offset/limit and marks truncation with a continuation hint', async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(join(workspace, 'big.txt'), `${body}\n`, 'utf8');

    const result = await readTool.execute({ path: 'big.txt', offset: 3, limit: 4 }, ctx(workspace));
    if (!result.ok) {
      expect.unreachable(result.error.message);
    }
    expect(result.content).toContain('3→line 3');
    expect(result.content).toContain('6→line 6');
    expect(result.content).not.toContain('7→line 7');
    expect(result.content).toContain('continue with offset: 7');
    expect(result.summary).toBe('read 4 of 10 lines');
  });

  it('truncates very long lines with a marker', async () => {
    await writeFile(join(workspace, 'long.txt'), `${'x'.repeat(3000)}\n`, 'utf8');
    const result = await readTool.execute({ path: 'long.txt' }, ctx(workspace));
    if (!result.ok) {
      expect.unreachable(result.error.message);
    }
    expect(result.content).toContain('[line truncated]');
    expect(result.content.length).toBeLessThan(2500);
  });

  it('errors legibly on missing files, directories, and binary content', async () => {
    const missing = await readTool.execute({ path: 'nope.txt' }, ctx(workspace));
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) {
      expect(missing.error.hint).toContain('glob');
    }

    const dir = await readTool.execute({ path: 'src' }, ctx(workspace));
    expect(dir).toMatchObject({ ok: false });

    await writeFile(join(workspace, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const binary = await readTool.execute({ path: 'blob.bin' }, ctx(workspace));
    expect(binary).toMatchObject({ ok: false });
    if (!binary.ok) {
      expect(binary.error.message).toContain('binary');
    }
  });

  it('handles empty files and past-the-end offsets', async () => {
    await writeFile(join(workspace, 'empty.txt'), '', 'utf8');
    const empty = await readTool.execute({ path: 'empty.txt' }, ctx(workspace));
    expect(empty).toMatchObject({ ok: true, content: '<empty file>' });

    const past = await readTool.execute({ path: 'src/one.ts', offset: 99 }, ctx(workspace));
    expect(past).toMatchObject({ ok: false });
  });

  it('refuses paths outside the workspace as a tool error (self-correctable)', async () => {
    const result = await readTool.execute({ path: '../elsewhere.txt' }, ctx(workspace));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('outside the workspace');
    }
  });
});

describe('glob tool', () => {
  it('matches recursively, newest first, relative to the workspace root', async () => {
    const result = await globTool.execute({ pattern: '**/*.ts' }, ctx(workspace));
    if (!result.ok) {
      expect.unreachable(result.error.message);
    }
    expect(result.content.split('\n')).toEqual([
      join('src', 'deep', 'two.ts'),
      join('src', 'one.ts')
    ]);
    expect(result.summary).toBe('2 files');
  });

  it('caps results with an explicit +N more marker', async () => {
    const result = await globTool.execute({ pattern: '**/*.ts', limit: 1 }, ctx(workspace));
    if (!result.ok) {
      expect.unreachable(result.error.message);
    }
    expect(result.content).toContain(join('src', 'deep', 'two.ts'));
    expect(result.content).toContain('+1 more');
  });

  it('scopes the search to a subdirectory', async () => {
    const result = await globTool.execute({ pattern: '*.ts', path: 'src/deep' }, ctx(workspace));
    if (!result.ok) {
      expect.unreachable(result.error.message);
    }
    expect(result.content.trim()).toBe(join('src', 'deep', 'two.ts'));
  });

  it('reports zero matches as a normal answer', async () => {
    const result = await globTool.execute({ pattern: '**/*.rs' }, ctx(workspace));
    expect(result).toMatchObject({ ok: true, summary: '0 files' });
  });

  it('denies directories outside the workspace', async () => {
    const result = await globTool.execute({ pattern: '*', path: '../..' }, ctx(workspace));
    expect(result).toMatchObject({ ok: false });
  });
});
