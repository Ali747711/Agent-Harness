import { z } from 'zod';

import { HarnessError } from '../errors/index.ts';
import {
  PermissionChoiceSchema,
  PermissionRequestSchema,
  PROTOCOL_VERSION,
  StopReasonSchema,
  UsageSchema
} from './types.ts';

/**
 * Core → client events (PHASE1-PLAN.md §4.6). Invariants:
 *  - every event survives JSON.stringify/parse byte-for-byte (headless mode
 *    is `JSON.stringify` per line — the enforcement mechanism);
 *  - strict objects: unknown keys are protocol violations, not extensions.
 */
const SessionStartedSchema = z.strictObject({
  type: z.literal('session_started'),
  sessionId: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  model: z.string(),
  workspaceRoot: z.string(),
  memoryFiles: z.array(z.string())
});

const TurnStartedSchema = z.strictObject({
  type: z.literal('turn_started'),
  turn: z.number().int().positive()
});

const AssistantTextDeltaSchema = z.strictObject({
  type: z.literal('assistant_text_delta'),
  text: z.string()
});

const AssistantThinkingDeltaSchema = z.strictObject({
  type: z.literal('assistant_thinking_delta'),
  text: z.string()
});

const ToolCallStartedSchema = z.strictObject({
  type: z.literal('tool_call_started'),
  callId: z.string(),
  tool: z.string(),
  title: z.string(),
  input: z.record(z.string(), z.unknown())
});

const ToolCallProgressSchema = z.strictObject({
  type: z.literal('tool_call_progress'),
  callId: z.string(),
  chunk: z.string()
});

const ToolCallCompletedSchema = z.strictObject({
  type: z.literal('tool_call_completed'),
  callId: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  durationMs: z.number().int().nonnegative()
});

const PermissionRequestedSchema = z.strictObject({
  type: z.literal('permission_requested'),
  requestId: z.string(),
  callId: z.string(),
  request: PermissionRequestSchema,
  suggestions: z.array(z.string())
});

const PermissionResolvedSchema = z.strictObject({
  type: z.literal('permission_resolved'),
  requestId: z.string(),
  choice: PermissionChoiceSchema,
  by: z.enum(['user', 'rule'])
});

const TurnCompletedSchema = z.strictObject({
  type: z.literal('turn_completed'),
  stopReason: StopReasonSchema,
  usage: UsageSchema,
  costUsd: z.number().nonnegative()
});

const ErrorEventSchema = z.strictObject({
  type: z.literal('error'),
  severity: z.enum(['warning', 'error', 'fatal']),
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean()
});

const SessionIdleSchema = z.strictObject({
  type: z.literal('session_idle')
});

export const AgentEventSchema = z.discriminatedUnion('type', [
  SessionStartedSchema,
  TurnStartedSchema,
  AssistantTextDeltaSchema,
  AssistantThinkingDeltaSchema,
  ToolCallStartedSchema,
  ToolCallProgressSchema,
  ToolCallCompletedSchema,
  PermissionRequestedSchema,
  PermissionResolvedSchema,
  TurnCompletedSchema,
  ErrorEventSchema,
  SessionIdleSchema
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent['type'];

export function parseAgentEvent(value: unknown): AgentEvent {
  const result = AgentEventSchema.safeParse(value);
  if (!result.success) {
    throw new HarnessError('protocol_invalid', 'invalid AgentEvent', {
      details: result.error.issues
    });
  }
  return result.data;
}
