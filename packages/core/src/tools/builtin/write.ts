import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { isHarnessError } from '../../errors/index.ts';
import { defineTool, errorResult, type RegisteredTool, type ToolResult } from '../tool.ts';
import { diffBadge, renderDiff } from './diff.ts';
import { atomicWrite, statTracked } from './fsutil.ts';

const WriteInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe('File path to create or overwrite, relative to the workspace root'),
  content: z.string().describe('Full file content (this tool replaces the whole file)')
});
type WriteInput = z.infer<typeof WriteInputSchema>;

export const writeTool: RegisteredTool = defineTool<WriteInput>({
  name: 'write',
  description: [
    'Create a new file or replace an existing one with the given content.',
    'Parent directories are created as needed. Overwriting an EXISTING file',
    'requires reading it first in this session (and it must be unchanged since).',
    'Prefer edit for partial changes — write replaces the entire file.'
  ].join(' '),
  schema: WriteInputSchema,
  readOnly: false,

  renderTitle: (input) => `Write ${input.path}`,

  plan: (input) => ({
    tool: 'write',
    title: `Write ${input.path}`,
    effects: [{ kind: 'write', path: input.path }]
  }),

  async execute(input, ctx): Promise<ToolResult> {
    let absolute: string;
    try {
      ({ absolute } = await ctx.resolvePath(input.path));
    } catch (error) {
      if (isHarnessError(error) && error.code === 'permission_denied') {
        return errorResult(error.message, 'stay inside the workspace root');
      }
      throw error;
    }

    // Read-before-overwrite invariant: never clobber content the model has
    // not seen in its current state.
    let existing: string | null = null;
    try {
      existing = await readFile(absolute, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        return errorResult(`cannot inspect ${input.path}: ${String(error)}`);
      }
    }
    if (existing !== null) {
      const tracked = ctx.files.get(absolute);
      if (tracked === undefined) {
        return errorResult(
          `${input.path} already exists and was not read this session`,
          'read the file first, then overwrite (or edit) it'
        );
      }
      const current = await statTracked(absolute, existing);
      if (current.sha256 !== tracked.sha256) {
        return errorResult(
          `${input.path} changed on disk since it was last read`,
          're-read the file and reapply your change to the current content'
        );
      }
    }

    try {
      await atomicWrite(absolute, input.content);
    } catch (error) {
      return errorResult(`write failed for ${input.path}: ${String(error)}`);
    }

    ctx.files.recordRead(absolute, await statTracked(absolute, input.content));

    const lines = input.content.length === 0 ? 0 : input.content.split('\n').length;
    const action = existing === null ? 'Created' : 'Overwrote';
    const diff = renderDiff(existing ?? '', input.content, input.path);
    return {
      ok: true,
      content: `${action} ${input.path} (${lines} lines, ${Buffer.byteLength(input.content, 'utf8')} bytes)`,
      summary: `${input.path}  ${diffBadge(diff.added, diff.removed)}`,
      display: diff.text,
      metadata: { created: existing === null, lines, added: diff.added, removed: diff.removed }
    };
  }
});
