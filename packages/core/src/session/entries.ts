import { z } from 'zod';

import { HarnessError } from '../errors/index.ts';
import type { AssistantBlock, ModelMessage, UserBlock } from '../model/types.ts';
import { StopReasonSchema, UsageSchema } from '../protocol/types.ts';

/**
 * Session transcript entries (ADR-0004). Append-only JSONL is the source of
 * truth; the id/parentId tree enables branching/rewind later, and agentId
 * scoping is the subagent reservation (ADR-0005) — a no-op while only the
 * root agent exists, but in the format from day one.
 *
 * Granularity note: entries mirror model-message granularity (tool_use /
 * tool_result live inside content arrays) so a resolved path replays to the
 * EXACT history the model saw — the fidelity R5 resume depends on.
 */
export const SESSION_FORMAT_VERSION = 1 as const;
export const ROOT_AGENT_ID = 'root';

const TextBlockSchema = z.strictObject({ type: z.literal('text'), text: z.string() });
const ThinkingBlockSchema = z.strictObject({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional()
});
const RedactedThinkingBlockSchema = z.strictObject({
  type: z.literal('redacted_thinking'),
  data: z.string()
});
const ToolUseBlockSchema = z.strictObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown())
});
const ToolResultBlockSchema = z.strictObject({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional()
});

export const AssistantBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema
]);
export const UserBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ToolResultBlockSchema
]);

const envelope = {
  v: z.literal(SESSION_FORMAT_VERSION),
  id: z.string(),
  parentId: z.string().nullable(),
  ts: z.string(),
  agentId: z.string(),
  parentAgentId: z.string().optional()
};

const MetaEntrySchema = z.strictObject({
  ...envelope,
  type: z.literal('meta'),
  data: z.strictObject({
    sessionId: z.string(),
    workspaceRoot: z.string(),
    model: z.string(),
    createdAt: z.string()
  })
});

const UserEntrySchema = z.strictObject({
  ...envelope,
  type: z.literal('user'),
  data: z.strictObject({ content: z.array(UserBlockSchema) })
});

const AssistantEntrySchema = z.strictObject({
  ...envelope,
  type: z.literal('assistant'),
  data: z.strictObject({
    content: z.array(AssistantBlockSchema),
    stopReason: StopReasonSchema,
    usage: UsageSchema
  })
});

const SystemEntrySchema = z.strictObject({
  ...envelope,
  type: z.literal('system'),
  data: z.strictObject({ text: z.string() })
});

/** Recorded permission decisions (populated from step 8). */
const PermissionEntrySchema = z.strictObject({
  ...envelope,
  type: z.literal('permission'),
  data: z.strictObject({
    requestId: z.string(),
    tool: z.string(),
    choice: z.enum(['allow_once', 'allow_session', 'deny']),
    by: z.enum(['user', 'rule'])
  })
});

export const SessionEntrySchema = z.discriminatedUnion('type', [
  MetaEntrySchema,
  UserEntrySchema,
  AssistantEntrySchema,
  SystemEntrySchema,
  PermissionEntrySchema
]);
export type SessionEntry = z.infer<typeof SessionEntrySchema>;
export type SessionEntryType = SessionEntry['type'];

export function parseSessionEntry(value: unknown): SessionEntry {
  const result = SessionEntrySchema.safeParse(value);
  if (!result.success) {
    throw new HarnessError('session_corrupt', 'invalid session entry', {
      details: result.error.issues
    });
  }
  return result.data;
}

export interface MakeEntryInput {
  parentId: string | null;
  agentId?: string;
  parentAgentId?: string;
}

type EntryBody = {
  [T in SessionEntryType]: { type: T; data: Extract<SessionEntry, { type: T }>['data'] };
}[SessionEntryType];

export function makeEntry(base: MakeEntryInput, body: EntryBody): SessionEntry {
  return {
    v: SESSION_FORMAT_VERSION,
    id: crypto.randomUUID(),
    parentId: base.parentId,
    ts: new Date().toISOString(),
    agentId: base.agentId ?? ROOT_AGENT_ID,
    ...(base.parentAgentId !== undefined && { parentAgentId: base.parentAgentId }),
    ...body
  } as SessionEntry;
}

/**
 * Walk the parentId chain from `leafId` (default: the last entry in the given
 * agent scope) back to the root, returning root→leaf order, filtered to the
 * agent scope. Subagent internals never leak into the root history (ADR-0005).
 */
export function resolvePath(
  entries: readonly SessionEntry[],
  leafId?: string,
  agentScope: string = ROOT_AGENT_ID
): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const leaf =
    leafId !== undefined
      ? byId.get(leafId)
      : [...entries].reverse().find((entry) => entry.agentId === agentScope);
  if (leaf === undefined) {
    return [];
  }

  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current !== undefined) {
    if (current.agentId === agentScope) {
      chain.push(current);
    }
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return chain.reverse();
}

/** Resolved entries → the exact conversation the model should see on resume. */
export function toModelMessages(entries: readonly SessionEntry[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const entry of entries) {
    switch (entry.type) {
      case 'user':
        // Schema-validated on read; cast bridges zod's `T | undefined` optionals
        // to the model types under exactOptionalPropertyTypes.
        messages.push({ role: 'user', content: entry.data.content as UserBlock[] });
        break;
      case 'assistant':
        messages.push({ role: 'assistant', content: entry.data.content as AssistantBlock[] });
        break;
      case 'system':
        messages.push({ role: 'system', content: entry.data.text });
        break;
      case 'meta':
      case 'permission':
        break;
      default: {
        const exhaustive: never = entry;
        throw new HarnessError('internal', `unhandled entry: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return messages;
}
