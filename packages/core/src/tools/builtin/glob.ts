import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { z } from 'zod';

import { isHarnessError } from '../../errors/index.ts';
import { runProcess } from '../../runtime/proc.ts';
import { defineTool, errorResult, type RegisteredTool, type ToolResult } from '../tool.ts';
import { rgBinary } from './rg.ts';

const DEFAULT_LIMIT = 200;
const SCAN_CAP = 5000;

const GlobInputSchema = z.strictObject({
  pattern: z.string().min(1).describe('Glob pattern, e.g. "**/*.ts" or "src/**/config.*"'),
  path: z
    .string()
    .optional()
    .describe('Directory to search, relative to the workspace root (default: the root)'),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe(`Maximum results (default ${DEFAULT_LIMIT})`)
});
type GlobInput = z.infer<typeof GlobInputSchema>;

export const globTool: RegisteredTool = defineTool<GlobInput>({
  name: 'glob',
  description: [
    'Find files by glob pattern. Returns paths relative to the workspace root,',
    'newest-modified first, capped at limit with an explicit "+N more" marker.',
    'Respects .gitignore. Use this before read when unsure of exact paths;',
    'use grep to search file CONTENTS.'
  ].join(' '),
  schema: GlobInputSchema,
  readOnly: true,

  renderTitle: (input) =>
    `Glob ${input.pattern}${input.path === undefined ? '' : ` in ${input.path}`}`,

  plan: (input) => ({
    tool: 'glob',
    title: `Glob ${input.pattern}`,
    effects: [{ kind: 'read', path: input.path ?? '.' }]
  }),

  async execute(input, ctx): Promise<ToolResult> {
    let searchDir: string;
    try {
      ({ absolute: searchDir } = await ctx.resolvePath(input.path ?? '.'));
    } catch (error) {
      if (isHarnessError(error) && error.code === 'permission_denied') {
        return errorResult(error.message, 'stay inside the workspace root');
      }
      throw error;
    }

    // Argv only — the pattern is never interpolated into a shell string.
    const result = await runProcess(
      [rgBinary(), '--files', '--sort-files', '--glob', input.pattern],
      { cwd: searchDir, signal: ctx.signal, timeoutMs: 30_000 }
    );

    // rg exits 1 for "no matches" — an answer, not a failure.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return errorResult(
        `glob failed (rg exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`
      );
    }

    const found = result.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(0, SCAN_CAP);

    if (found.length === 0) {
      return {
        ok: true,
        content: `No files matched ${input.pattern}`,
        summary: '0 files',
        metadata: { matches: 0 }
      };
    }

    const withMtime = await Promise.all(
      found.map(async (line) => {
        const absolute = join(searchDir, line);
        const mtimeMs = await stat(absolute)
          .then((info) => info.mtimeMs)
          .catch(() => 0);
        return { absolute, mtimeMs };
      })
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const rootResolved = await ctx.resolvePath('.');
    const limit = input.limit ?? DEFAULT_LIMIT;
    const shown = withMtime
      .slice(0, limit)
      .map((entry) => relative(rootResolved.absolute, entry.absolute));
    const more = withMtime.length - shown.length;

    return {
      ok: true,
      content: [
        ...shown,
        ...(more > 0 ? [`… +${more} more (raise limit or narrow the pattern)`] : [])
      ].join('\n'),
      summary: `${withMtime.length} file${withMtime.length === 1 ? '' : 's'}`,
      metadata: { matches: withMtime.length, shown: shown.length }
    };
  }
});
