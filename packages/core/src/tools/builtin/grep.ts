import { z } from 'zod';

import { isHarnessError } from '../../errors/index.ts';
import { runProcess } from '../../runtime/proc.ts';
import { defineTool, errorResult, type RegisteredTool, type ToolResult } from '../tool.ts';
import { RIPGREP_MISSING_HINT, rgBinary } from './rg.ts';

const DEFAULT_LIMIT = 100;

const GrepInputSchema = z.strictObject({
  pattern: z.string().min(1).describe('Regular expression (ripgrep syntax)'),
  path: z
    .string()
    .optional()
    .describe('File or directory to search, relative to the workspace root (default: the root)'),
  glob: z.string().optional().describe('Filter files by glob, e.g. "*.ts"'),
  mode: z
    .enum(['content', 'files', 'count'])
    .optional()
    .describe('content: matching lines (default) · files: paths only · count: per-file counts'),
  context: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Context lines around each match (content mode)'),
  ignore_case: z.boolean().optional(),
  multiline: z.boolean().optional().describe('Let the pattern span lines'),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe(`Maximum output lines (default ${DEFAULT_LIMIT})`)
});
type GrepInput = z.infer<typeof GrepInputSchema>;

export const grepTool: RegisteredTool = defineTool<GrepInput>({
  name: 'grep',
  description: [
    'Search file CONTENTS with ripgrep. Returns matching lines with file:line',
    'prefixes (content mode), matching file paths (files mode), or per-file',
    'match counts (count mode). Respects .gitignore. The pattern is a regex —',
    'escape literal dots/brackets. Use glob to find files by NAME instead.'
  ].join(' '),
  schema: GrepInputSchema,
  readOnly: true,

  renderTitle: (input) => `Grep ${input.pattern}`,

  plan: (input) => ({
    tool: 'grep',
    title: `Grep ${input.pattern}`,
    effects: [{ kind: 'read', path: input.path ?? '.' }]
  }),

  async execute(input, ctx): Promise<ToolResult> {
    let target: string;
    try {
      ({ absolute: target } = await ctx.resolvePath(input.path ?? '.'));
    } catch (error) {
      if (isHarnessError(error) && error.code === 'permission_denied') {
        return errorResult(error.message, 'stay inside the workspace root');
      }
      throw error;
    }

    // Argv array only — the pattern is passed as a single argument after
    // `--regexp`, so shell metacharacters in it are always literal.
    const argv = [rgBinary(), '--no-heading', '--color', 'never'];
    switch (input.mode ?? 'content') {
      case 'files':
        argv.push('--files-with-matches');
        break;
      case 'count':
        argv.push('--count');
        break;
      case 'content':
        argv.push('--line-number');
        if (input.context !== undefined && input.context > 0) {
          argv.push('--context', String(input.context));
        }
        break;
      default:
        break;
    }
    if (input.ignore_case === true) {
      argv.push('--ignore-case');
    }
    if (input.multiline === true) {
      argv.push('--multiline', '--multiline-dotall');
    }
    if (input.glob !== undefined) {
      argv.push('--glob', input.glob);
    }
    argv.push('--regexp', input.pattern, target);

    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(argv, {
        cwd: ctx.workspaceRoot,
        signal: ctx.signal,
        timeoutMs: 30_000
      });
    } catch (error) {
      if (isHarnessError(error) && error.code === 'aborted') {
        throw error;
      }
      return errorResult(`could not run ripgrep: ${String(error)}`, RIPGREP_MISSING_HINT);
    }

    // rg: exit 1 = no matches (an answer); 2 = real error (bad regex etc.).
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return errorResult(
        `grep failed: ${result.stderr.trim().slice(0, 500)}`,
        'check the regex syntax (ripgrep dialect)'
      );
    }

    const rootPrefix = `${(await ctx.resolvePath('.')).absolute}/`;
    const lines = result.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (line.startsWith(rootPrefix) ? line.slice(rootPrefix.length) : line));

    if (lines.length === 0) {
      return {
        ok: true,
        content: `No matches for ${input.pattern}`,
        summary: '0 matches',
        metadata: { matches: 0 }
      };
    }

    const limit = input.limit ?? DEFAULT_LIMIT;
    const shown = lines.slice(0, limit);
    const more = lines.length - shown.length;
    return {
      ok: true,
      content: [
        ...shown,
        ...(more > 0 ? [`… +${more} more lines (raise limit or narrow the pattern)`] : [])
      ].join('\n'),
      summary: `${lines.length} matching line${lines.length === 1 ? '' : 's'}`,
      metadata: { lines: lines.length, shown: shown.length }
    };
  }
});
