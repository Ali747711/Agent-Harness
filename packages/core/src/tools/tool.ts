import type { z } from 'zod';

import type { CommandRunner } from '../exec/runner.ts';
import type { ResolvedPath } from '../permissions/guard.ts';
import type { PermissionRequest } from '../protocol/types.ts';
import type { FileTracker } from './tracker.ts';

/**
 * Tool contract (PHASE1-PLAN.md §4.2). The critical split: `plan()` is a pure
 * declaration of effects (what the permission engine gates and the TUI shows
 * BEFORE approval); `execute()` performs them. Tools resolve every
 * model-supplied path through ctx.resolvePath — the workspace guard — at
 * execute time, so confinement is re-checked after approval (TOCTOU).
 *
 * Failures are RETURNED as `{ ok: false }` results (the model self-corrects
 * from tool_result errors); tools only throw for cancellation ('aborted').
 */
export interface ToolPlanContext {
  workspaceRoot: string;
}

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  /** Workspace guard — throws HarnessError('permission_denied') on escape. */
  resolvePath(candidate: string): Promise<ResolvedPath>;
  /** Session-scoped read-before-write state (step 9 invariant). */
  files: FileTracker;
  /** Shell execution seam — the Phase-2 sandbox swaps in here (step 10). */
  runner: CommandRunner;
  /** Live output chunks; the loop forwards them as tool_call_progress events. */
  onProgress?: (chunk: string) => void;
}

export type ToolResult =
  | {
      ok: true;
      /** What the model sees (budgeted; explicit truncation markers). */
      content: string;
      /** One-line human summary for tool_call_completed events. */
      summary: string;
      /** Optional richer client rendering (e.g. a diff). */
      display?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: { message: string; hint?: string };
    };

export interface Tool<I> {
  readonly name: string;
  /** Product surface (~9k-token budget across the set — ADR-0007). */
  readonly description: string;
  readonly schema: z.ZodType<I>;
  /** Drives default permissions now, parallel scheduling later. */
  readonly readOnly: boolean;
  renderTitle(input: I): string;
  plan(input: I, ctx: ToolPlanContext): PermissionRequest;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Type-erased runtime form. The single cast below is safe because the loop
 * validates input against `schema` before any method is called.
 */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<unknown>;
  readonly readOnly: boolean;
  renderTitle(input: unknown): string;
  plan(input: unknown, ctx: ToolPlanContext): PermissionRequest;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<I>(tool: Tool<I>): RegisteredTool {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema as z.ZodType<unknown>,
    readOnly: tool.readOnly,
    renderTitle: (input) => tool.renderTitle(input as I),
    plan: (input, ctx) => tool.plan(input as I, ctx),
    execute: (input, ctx) => tool.execute(input as I, ctx)
  };
}

export function errorResult(message: string, hint?: string): ToolResult {
  return { ok: false, error: { message, ...(hint !== undefined && { hint }) } };
}
