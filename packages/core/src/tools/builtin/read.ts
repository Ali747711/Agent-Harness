import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { z } from 'zod';

import { isHarnessError } from '../../errors/index.ts';
import { defineTool, errorResult, type RegisteredTool, type ToolResult } from '../tool.ts';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_CONTENT_BYTES = 262_144; // 256 KiB result budget (ADR-0007)

const ReadInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe('File path, relative to the workspace root (absolute paths must stay inside it)'),
  offset: z.number().int().positive().optional().describe('1-based line number to start from'),
  limit: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .describe(`Maximum lines to return (default ${DEFAULT_LIMIT})`)
});
type ReadInput = z.infer<typeof ReadInputSchema>;

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}

export const readTool: RegisteredTool = defineTool<ReadInput>({
  name: 'read',
  description: [
    'Read a file from the workspace. Returns line-numbered content in the form "N→text".',
    'For large files, page with offset (1-based first line) and limit; the result says when it is truncated.',
    `Lines longer than ${MAX_LINE_CHARS} characters are cut with a marker.`,
    'Fails with a clear error on binary files, directories, and paths outside the workspace.',
    'Use glob first when unsure of the exact path.'
  ].join(' '),
  schema: ReadInputSchema,
  readOnly: true,

  renderTitle: (input) => `Read ${input.path}`,

  plan: (input) => ({
    tool: 'read',
    title: `Read ${input.path}`,
    effects: [{ kind: 'read', path: input.path }]
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

    let raw: Buffer;
    try {
      const info = await stat(absolute);
      if (info.isDirectory()) {
        return errorResult(`${input.path} is a directory`, 'use glob to list files inside it');
      }
      raw = await readFile(absolute);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return errorResult(`file not found: ${input.path}`, 'use glob to find the right path');
      }
      return errorResult(`cannot read ${input.path}: ${String(error)}`);
    }

    if (looksBinary(raw)) {
      return errorResult(`${input.path} looks binary — not returning raw bytes`);
    }

    const fileInfo = await stat(absolute);
    const text = raw.toString('utf8');
    const allLines = text.split('\n');
    // A trailing newline produces one phantom empty tail line; drop it.
    if (allLines.at(-1) === '') {
      allLines.pop();
    }

    if (allLines.length === 0) {
      return {
        ok: true,
        content: '<empty file>',
        summary: 'read 0 lines',
        metadata: { lines: 0, bytes: raw.byteLength }
      };
    }

    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (offset > allLines.length) {
      return errorResult(`offset ${offset} is past the end of the file (${allLines.length} lines)`);
    }

    const window = allLines.slice(offset - 1, offset - 1 + limit);
    const numbered: string[] = [];
    let bytes = 0;
    let truncatedByBytes = false;
    for (const [index, line] of window.entries()) {
      const shown =
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
      const rendered = `${offset + index}→${shown}`;
      bytes += rendered.length + 1;
      if (bytes > MAX_CONTENT_BYTES) {
        truncatedByBytes = true;
        break;
      }
      numbered.push(rendered);
    }

    const shownCount = numbered.length;
    const lastShown = offset + shownCount - 1;
    const moreLines = allLines.length - lastShown;
    const notices: string[] = [];
    if (truncatedByBytes || moreLines > 0) {
      notices.push(
        `… [truncated: showing lines ${offset}-${lastShown} of ${allLines.length}; continue with offset: ${lastShown + 1}]`
      );
    }

    return {
      ok: true,
      content: [...numbered, ...notices].join('\n'),
      summary: `read ${shownCount} of ${allLines.length} lines`,
      metadata: {
        lines: allLines.length,
        shown: shownCount,
        bytes: raw.byteLength,
        // Step 9's read-before-write invariant consumes these.
        mtimeMs: fileInfo.mtimeMs,
        sha256: createHash('sha256').update(raw).digest('hex')
      }
    };
  }
});
