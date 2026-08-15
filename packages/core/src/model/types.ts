import type { Effort, ThinkingMode } from '../config/schema.ts';
import type { StopReason, Usage } from '../protocol/types.ts';

/**
 * Normalized model-layer types (PHASE1-PLAN.md §4.1). Vendor SDK types must
 * never appear here — this is the boundary the whole loop programs against.
 * Sampling parameters are deliberately not representable (ADR-0010).
 */

// ---------- conversation content ----------

export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * Thinking blocks must be echoed back to the same model unchanged (signature
 * included) when continuing a conversation; other models drop them.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type AssistantBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock;
export type UserBlock = TextBlock | ToolResultBlock;

export type ModelMessage =
  | { role: 'user'; content: UserBlock[] }
  | { role: 'assistant'; content: AssistantBlock[] }
  /**
   * Mid-conversation operator instruction — cache-safe dynamic context
   * (ADR-0008). Only valid when capabilities(model).systemRoleMessages.
   */
  | { role: 'system'; content: string };

// ---------- request ----------

/** One block of the frozen system prompt; `cache` marks a breakpoint. */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

/** Wire-ready tool spec (JSON Schema already derived from Zod by the registry). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}

export interface ModelRequest {
  model: string;
  effort: Effort;
  thinking: ThinkingMode;
  maxTokens: number;
  system: SystemBlock[];
  tools: ToolSpec[];
  messages: ModelMessage[];
  /**
   * Indices into `messages`; a cache breakpoint is placed on the last content
   * block of each referenced message (ADR-0008 rolling-tail breakpoints).
   */
  cacheBreakpoints?: number[];
}

// ---------- stream ----------

export type ModelStreamEvent =
  | { type: 'message_start'; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partialJson: string }
  | { type: 'tool_use_complete'; id: string; name: string; input: Record<string, unknown> }
  /**
   * Terminal event. Carries the fully accumulated assistant content so the
   * loop appends exact blocks (thinking signatures included) to history
   * without re-assembling deltas.
   */
  | { type: 'message_stop'; stopReason: StopReason; usage: Usage; content: AssistantBlock[] };

// ---------- capabilities ----------

/** Provider differences branch on flags, never on provider names (ADR-0010). */
export interface ModelCapabilities {
  systemRoleMessages: boolean;
  adaptiveThinking: boolean;
  effortLevels: readonly Effort[];
  maxCacheBreakpoints: number;
}
