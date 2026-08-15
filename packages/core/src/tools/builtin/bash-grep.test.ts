import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DirectCommandRunner } from '../../exec/direct.ts';
import { resolveWorkspacePath } from '../../permissions/guard.ts';
import type { ToolContext } from '../tool.ts';
import { FileTracker } from '../tracker.ts';
import { bashTool } from './bash.ts';
import { grepTool } from './grep.ts';

let workspace: string;
let chunks: string[];
let ctx: ToolContext;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'harness-bashgrep-'));
  chunks = [];
  ctx = {
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    resolvePath: (candidate) => resolveWorkspacePath(workspace, candidate),
    files: new FileTracker(),
    runner: new DirectCommandRunner({ PATH: process.env.PATH ?? '' }),
    onProgress: (chunk) => {
      chunks.push(chunk);
    }
  };
  await mkdir(join(workspace, 'src', 'deep'), { recursive: true });
  await writeFile(
    join(workspace, 'src', 'one.ts'),
    'const alpha = 1;\nfunction beta() {}\nconst gamma = alpha;\n',
    'utf8'
  );
  await writeFile(join(workspace, 'src', 'deep', 'two.ts'), 'alpha again\n', 'utf8');
  await writeFile(join(workspace, 'notes.md'), 'alpha note\n', 'utf8');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('bash tool', () => {
  it('runs in the canonical workspace root and streams progress', async () => {
    const result = await bashTool.execute({ command: 'pwd; echo streamed' }, ctx);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const root = (await ctx.resolvePath('.')).absolute;
      expect(result.content).toContain(root);
      // The duration is reported by the UI row, not duplicated in the summary.
      expect(result.summary).toBe('exit 0');
    }
    expect(chunks.join('')).toContain('streamed');
  });

  it('returns failures with the exit code and output embedded', async () => {
    const result = await bashTool.execute({ command: 'echo diagnostic-line >&2; exit 7' }, ctx);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('exit 7');
      expect(result.error.message).toContain('diagnostic-line');
    }
  });

  it('reports timeouts as errors with a hint', async () => {
    const result = await bashTool.execute({ command: 'sleep 5', timeout_ms: 150 }, ctx);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.message).toContain('timed out');
      expect(result.error.hint).toContain('timeout_ms');
    }
  });

  it('caps long output preserving head and tail', async () => {
    const result = await bashTool.execute(
      { command: 'for i in $(seq 1 6000); do echo "line-$i"; done' },
      ctx
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.content).toContain('line-1\n');
      expect(result.content).toContain('line-6000');
      expect(result.content).toContain('chars truncated');
      expect(result.content.length).toBeLessThan(40_000);
    }
  });

  it('renders titles from description or truncated command', () => {
    expect(bashTool.renderTitle({ command: 'ls', description: 'List files' })).toBe('List files');
    const long = 'echo '.repeat(30);
    expect(bashTool.renderTitle({ command: long }).length).toBeLessThanOrEqual(60);
  });
});

describe('grep tool', () => {
  it('content mode returns file:line matches relative to the root', async () => {
    const result = await grepTool.execute({ pattern: 'alpha' }, ctx);
    expect(result).toMatchObject({ ok: true, summary: '4 matching lines' });
    if (result.ok) {
      expect(result.content).toContain('src/one.ts:1:const alpha = 1;');
      expect(result.content).toContain('src/deep/two.ts:1:alpha again');
      expect(result.content).toContain('notes.md:1:alpha note');
    }
  });

  it('files and count modes work', async () => {
    const files = await grepTool.execute({ pattern: 'alpha', mode: 'files' }, ctx);
    if (!files.ok) {
      expect.unreachable(files.error.message);
    }
    expect(files.content.split('\n').sort()).toEqual(['notes.md', 'src/deep/two.ts', 'src/one.ts']);

    const counts = await grepTool.execute({ pattern: 'alpha', mode: 'count' }, ctx);
    if (!counts.ok) {
      expect.unreachable(counts.error.message);
    }
    expect(counts.content).toContain('src/one.ts:2');
  });

  it('filters by glob and scopes by path', async () => {
    const globbed = await grepTool.execute({ pattern: 'alpha', glob: '*.ts' }, ctx);
    if (!globbed.ok) {
      expect.unreachable(globbed.error.message);
    }
    expect(globbed.content).not.toContain('notes.md');

    const scoped = await grepTool.execute({ pattern: 'alpha', path: 'src/deep' }, ctx);
    if (!scoped.ok) {
      expect.unreachable(scoped.error.message);
    }
    expect(scoped.content).toContain('alpha again');
    expect(scoped.content).not.toContain('one.ts');
  });

  it('treats shell metacharacters in patterns as literal regex input', async () => {
    const result = await grepTool.execute({ pattern: '"; touch pwned; echo "' }, ctx);
    expect(result).toMatchObject({ ok: true, summary: '0 matches' });
    const pwned = await grepTool
      .execute({ pattern: 'x', path: 'pwned' }, ctx)
      .then((r) => (r.ok ? 'exists' : r.error.message));
    expect(pwned).toContain('No such file');
  });

  it('reports bad regexes legibly', async () => {
    const result = await grepTool.execute({ pattern: '([' }, ctx);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.hint).toContain('regex');
    }
  });

  it('supports context lines, case-insensitivity, and limits', async () => {
    const context = await grepTool.execute({ pattern: 'beta', context: 1 }, ctx);
    if (!context.ok) {
      expect.unreachable(context.error.message);
    }
    expect(context.content).toContain('alpha = 1');

    const ci = await grepTool.execute({ pattern: 'ALPHA', ignore_case: true }, ctx);
    expect(ci).toMatchObject({ ok: true, summary: '4 matching lines' });

    const limited = await grepTool.execute({ pattern: 'alpha', limit: 2 }, ctx);
    if (!limited.ok) {
      expect.unreachable(limited.error.message);
    }
    expect(limited.content).toContain('+2 more lines');
  });

  it('denies out-of-workspace targets', async () => {
    const result = await grepTool.execute({ pattern: 'x', path: '../..' }, ctx);
    expect(result).toMatchObject({ ok: false });
  });
});
