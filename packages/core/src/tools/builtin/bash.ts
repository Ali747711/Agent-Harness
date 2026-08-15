import { z } from 'zod';

import { defineTool, type RegisteredTool, type ToolResult } from '../tool.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 4_000_000;
const MAX_RESULT_CHARS = 30_000;

const BashInputSchema = z.strictObject({
  command: z.string().min(1).describe('Shell command, run via bash -c in the workspace root'),
  description: z
    .string()
    .max(100)
    .optional()
    .describe('Short human-readable label for what this command does'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`)
});
type BashInput = z.infer<typeof BashInputSchema>;

/** Cap long output keeping head and tail — failures usually live at the ends. */
function capMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${dropped} chars truncated] …\n${text.slice(-tail)}`;
}

function renderOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim().length > 0) {
    parts.push(stdout.trimEnd());
  }
  if (stderr.trim().length > 0) {
    parts.push(`--- stderr ---\n${stderr.trimEnd()}`);
  }
  return parts.length > 0 ? capMiddle(parts.join('\n'), MAX_RESULT_CHARS) : '(no output)';
}

export const bashTool: RegisteredTool = defineTool<BashInput>({
  name: 'bash',
  description: [
    'Run a shell command with bash -c from the workspace root and return its',
    'combined output. Non-zero exits and timeouts come back as errors that',
    'include the output — read it and adapt. Long output is truncated in the',
    'middle (head and tail preserved). Not for reading or editing files: use',
    'the read/write/edit/glob/grep tools, which are safer and cheaper.',
    `Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s.`
  ].join(' '),
  schema: BashInputSchema,
  readOnly: false,

  renderTitle: (input) =>
    input.description ??
    (input.command.length > 60 ? `${input.command.slice(0, 57)}…` : input.command),

  plan: (input) => ({
    tool: 'bash',
    title: input.description ?? input.command.slice(0, 100),
    effects: [{ kind: 'execute', command: input.command }]
  }),

  async execute(input, ctx): Promise<ToolResult> {
    // Pin cwd to the canonical workspace root.
    const { absolute: cwd } = await ctx.resolvePath('.');

    const result = await ctx.runner.run({
      command: input.command,
      cwd,
      timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: ctx.signal,
      ...(ctx.onProgress !== undefined && {
        onChunk: (chunk: string) => ctx.onProgress?.(chunk.slice(0, 4096))
      })
    });

    const output = renderOutput(result.stdout, result.stderr);
    const truncationNote = result.truncated
      ? '\n[output exceeded the byte cap and was dropped]'
      : '';

    if (result.timedOut) {
      return {
        ok: false,
        error: {
          message: `command timed out after ${input.timeout_ms ?? DEFAULT_TIMEOUT_MS}ms\n${output}${truncationNote}`,
          hint: 'raise timeout_ms, or run a smaller piece of the work'
        }
      };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: {
          message: `command failed (exit ${result.exitCode})\n${output}${truncationNote}`,
          hint: 'read the output above and adjust the command or the code it exercises'
        }
      };
    }
    return {
      ok: true,
      content: `${output}${truncationNote}`,
      summary: `exit 0 in ${result.durationMs}ms`,
      metadata: { exitCode: result.exitCode, durationMs: result.durationMs }
    };
  }
});
