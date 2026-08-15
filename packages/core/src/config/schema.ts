import { z } from 'zod';

/**
 * Model configuration is exactly (model, effort, thinking) + maxTokens
 * (ADR-0010). Sampling parameters (temperature/top_p/top_k) are deliberately
 * not representable: strict schemas reject them as unknown keys, so passing
 * one is a config validation error — never a silently-dropped field.
 *
 * The API key is NEVER config-file material: it is read from the
 * ANTHROPIC_API_KEY environment variable at the model-client boundary.
 *
 * Defaults live in CONFIG_DEFAULTS, not in the schema: layer parsing must
 * yield only the keys a layer actually set (Zod defaults would silently
 * re-inject values into every layer and break precedence).
 */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

export const ThinkingModeSchema = z.enum(['adaptive', 'disabled']);
export type ThinkingMode = z.infer<typeof ThinkingModeSchema>;

export const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'bypass']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

const configFields = {
  model: z.string().min(1),
  effort: EffortSchema,
  thinking: ThinkingModeSchema,
  maxTokens: z.number().int().positive().max(128_000),
  maxTurns: z.number().int().positive().max(1_000),
  permissionMode: PermissionModeSchema,
  /** Ordered project-memory load list (ADR-0009). Later layers replace wholesale. */
  memoryFiles: z.array(z.string().min(1))
} as const;

/** A complete, valid configuration. */
export const ConfigSchema = z.strictObject(configFields);
export type Config = z.infer<typeof ConfigSchema>;

/** Strict partial — one layer of the merge (file / env / flags). No defaults. */
export const PartialConfigSchema = ConfigSchema.partial();
export type PartialConfig = z.infer<typeof PartialConfigSchema>;

export const CONFIG_DEFAULTS: Config = {
  model: 'claude-opus-5',
  effort: 'xhigh',
  thinking: 'adaptive',
  maxTokens: 32_000,
  maxTurns: 40,
  permissionMode: 'default',
  memoryFiles: ['HARNESS.md', 'AGENTS.md', 'CLAUDE.md']
};

export const CONFIG_KEYS = Object.keys(configFields) as ReadonlyArray<keyof Config>;
