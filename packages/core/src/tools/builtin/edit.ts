import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { isHarnessError } from '../../errors/index.ts';
import { defineTool, errorResult, type RegisteredTool, type ToolResult } from '../tool.ts';
import { diffBadge, renderDiff } from './diff.ts';
import { atomicWrite, statTracked } from './fsutil.ts';

const EditInputSchema = z.strictObject({
  path: z.string().min(1).describe('File to edit, relative to the workspace root'),
  old_string: z
    .string()
    .min(1)
    .describe('Exact text to replace — must match the file byte-for-byte, whitespace included'),
  new_string: z.string().describe('Replacement text (must differ from old_string)'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence (default: old_string must be unique)')
});
type EditInput = z.infer<typeof EditInputSchema>;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export const editTool: RegisteredTool = defineTool<EditInput>({
  name: 'edit',
  description: [
    'Replace exact text in a file (no regex). The file must have been read in',
    'this session and be unchanged since. old_string must match exactly,',
    'including whitespace and indentation; if it matches more than once, add',
    'surrounding context to make it unique or set replace_all: true.'
  ].join(' '),
  schema: EditInputSchema,
  readOnly: false,

  renderTitle: (input) => `Edit ${input.path}`,

  plan: (input) => ({
    tool: 'edit',
    title: `Edit ${input.path}`,
    effects: [
      { kind: 'read', path: input.path },
      { kind: 'write', path: input.path }
    ]
  }),

  async execute(input, ctx): Promise<ToolResult> {
    if (input.old_string === input.new_string) {
      return errorResult('old_string and new_string are identical', 'nothing to change');
    }

    let absolute: string;
    try {
      ({ absolute } = await ctx.resolvePath(input.path));
    } catch (error) {
      if (isHarnessError(error) && error.code === 'permission_denied') {
        return errorResult(error.message, 'stay inside the workspace root');
      }
      throw error;
    }

    let content: string;
    try {
      content = await readFile(absolute, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return errorResult(`file not found: ${input.path}`, 'use write to create new files');
      }
      return errorResult(`cannot read ${input.path}: ${String(error)}`);
    }

    // Read-before-write invariant (step 9).
    const tracked = ctx.files.get(absolute);
    if (tracked === undefined) {
      return errorResult(
        `${input.path} was not read this session`,
        'read the file first so the edit applies to content you have seen'
      );
    }
    const current = await statTracked(absolute, content);
    if (current.sha256 !== tracked.sha256) {
      return errorResult(
        `${input.path} changed on disk since it was last read`,
        're-read the file and reapply the edit to the current content'
      );
    }

    const occurrences = countOccurrences(content, input.old_string);
    if (occurrences === 0) {
      return errorResult(
        `old_string not found in ${input.path}`,
        're-read the file — the match must be exact, including whitespace and indentation'
      );
    }
    if (occurrences > 1 && input.replace_all !== true) {
      return errorResult(
        `old_string matches ${occurrences} places in ${input.path}`,
        'add surrounding lines to make it unique, or set replace_all: true'
      );
    }

    const updated =
      input.replace_all === true
        ? content.replaceAll(input.old_string, input.new_string)
        : content.replace(input.old_string, input.new_string);

    try {
      await atomicWrite(absolute, updated);
    } catch (error) {
      return errorResult(`edit failed for ${input.path}: ${String(error)}`);
    }

    ctx.files.recordRead(absolute, await statTracked(absolute, updated));

    const replaced = input.replace_all === true ? occurrences : 1;
    const diff = renderDiff(content, updated, input.path);
    return {
      ok: true,
      content: `Edited ${input.path}: replaced ${replaced} occurrence${replaced === 1 ? '' : 's'}`,
      summary: `${input.path}  ${diffBadge(diff.added, diff.removed)}`,
      display: diff.text,
      metadata: { replacements: replaced, added: diff.added, removed: diff.removed }
    };
  }
});
