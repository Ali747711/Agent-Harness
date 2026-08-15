import { z } from 'zod';

import { parseRule } from '../permissions/rules.ts';

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

/** Rule strings are validated at parse time so bad rules fail at config load
 *  with origin attribution — never silently at decision time (ADR-0006). */
const RuleListSchema = z.array(
  z.string().superRefine((value, ctx) => {
    try {
      parseRule(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : `invalid permission rule: ${value}`
      });
    }
  })
);

const configFields = {
  model: z.string().min(1),
  effort: EffortSchema,
  thinking: ThinkingModeSchema,
  maxTokens: z.number().int().positive().max(128_000),
  maxTurns: z.number().int().positive().max(1_000),
  permissionMode: PermissionModeSchema,
  /** Allow/deny rule lists (ADR-0006). Layers replace this key wholesale. */
  permissions: z.strictObject({
    allow: RuleListSchema,
    deny: RuleListSchema
  }),
  /** Ordered project-memory load list (ADR-0009). Later layers replace wholesale. */
  memoryFiles: z.array(z.string().min(1)),
  /**
   * OS-level confinement for bash (ADR-0006). Off by default: the runtime's
   * network layer could not be verified working, and it has no "allow all"
   * setting — so enabling it also denies egress to anything not in
   * allowedDomains. Run `harness doctor` to check this machine before
   * turning it on.
   */
  sandbox: z.strictObject({
    enabled: z.boolean(),
    /** Extra writable roots. The workspace root is always added. */
    allowWrite: z.array(z.string().min(1)),
    /** Extra denied reads, on top of the credential defaults. */
    denyRead: z.array(z.string().min(1)),
    /** Egress allowlist. Empty denies all network from inside bash. */
    allowedDomains: z.array(z.string().min(1))
  })
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
  permissions: { allow: [], deny: [] },
  memoryFiles: ['HARNESS.md', 'AGENTS.md', 'CLAUDE.md'],
  sandbox: { enabled: false, allowWrite: [], denyRead: [], allowedDomains: [] }
};

export const CONFIG_KEYS = Object.keys(configFields) as ReadonlyArray<keyof Config>;
