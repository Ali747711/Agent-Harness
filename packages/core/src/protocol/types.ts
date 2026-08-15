import { z } from 'zod';

/**
 * Wire-level shared types for the core ↔ client protocol (ADR-0003).
 * Bumped on any breaking change to events or commands.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Stop reasons mirror the model API surface (ADR-0010). The agent loop must
 * switch exhaustively over these — new values are compile errors, not silent
 * fallthroughs.
 */
export const StopReasonSchema = z.enum([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'refusal',
  'pause_turn'
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Token accounting comes from API usage fields only — never estimated (ADR-0008). */
export const UsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative()
});
export type Usage = z.infer<typeof UsageSchema>;

export const PermissionChoiceSchema = z.enum(['allow_once', 'allow_session', 'deny']);
export type PermissionChoice = z.infer<typeof PermissionChoiceSchema>;

/**
 * A tool's declared effects, produced by Tool.plan() (ADR-0006). Minimal seam
 * for step 8; the permission engine extends matching, not this wire shape.
 */
export const PermissionEffectSchema = z.strictObject({
  kind: z.enum(['read', 'write', 'execute']),
  path: z.string().optional(),
  command: z.string().optional()
});
export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;

export const PermissionRequestSchema = z.strictObject({
  tool: z.string(),
  title: z.string(),
  effects: z.array(PermissionEffectSchema)
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;
