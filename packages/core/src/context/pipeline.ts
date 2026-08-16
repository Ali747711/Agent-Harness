import type { Config } from '../config/schema.ts';
import type {
  ModelCapabilities,
  ModelMessage,
  ModelRequest,
  SystemBlock,
  ToolSpec
} from '../model/types.ts';
import type { Usage } from '../protocol/types.ts';
import { type LedgerTotals, TokenLedger } from './ledger.ts';

/**
 * ContextPipeline (ADR-0008): turns session state into a cache-optimal
 * ModelRequest and accounts for tokens. Phase 1 ships PassthroughPipeline;
 * Phase 2 swaps in CompactingPipeline / ServerSideCompactionPipeline behind
 * this interface without touching the loop.
 */
export interface PipelineState {
  messages: readonly ModelMessage[];
}

export interface ContextPipeline {
  build(state: PipelineState): ModelRequest;
  observeUsage(usage: Usage): void;
  totals(): LedgerTotals;
  shouldCompact(): boolean;
}

export interface PassthroughPipelineOptions {
  config: Config;
  /** Frozen at session start — never rebuilt per turn. */
  system: SystemBlock[];
  /** Deterministically ordered, computed once by the registry. */
  tools: ToolSpec[];
  capabilities: ModelCapabilities;
}

/**
 * Cache breakpoint placement:
 *  - the stable prefix (tools + system) carries its breakpoint on the last
 *    system block, set by buildSystemPrompt;
 *  - a rolling breakpoint sits on the last message so each turn extends the
 *    cached region;
 *  - for tool-heavy turns an extra breakpoint is placed further back, because
 *    the provider's cache lookback is limited to the last 20 content blocks
 *    and a long tool batch can push the previous breakpoint out of range.
 */
const LOOKBACK_SAFETY_MESSAGES = 6;

/** The per-request knobs, separated from frozen prefix material. */
export interface ModelSettings {
  model: Config['model'];
  effort: Config['effort'];
  thinking: Config['thinking'];
  maxTokens: Config['maxTokens'];
}

export class PassthroughPipeline implements ContextPipeline {
  private readonly ledger: TokenLedger;
  private settings: ModelSettings;
  private capabilities: ModelCapabilities;

  constructor(private readonly options: PassthroughPipelineOptions) {
    this.ledger = new TokenLedger(options.config.model);
    this.settings = {
      model: options.config.model,
      effort: options.config.effort,
      thinking: options.config.thinking,
      maxTokens: options.config.maxTokens
    };
    this.capabilities = options.capabilities;
  }

  get modelSettings(): ModelSettings {
    return { ...this.settings };
  }

  /**
   * Change per-request settings mid-session. Safe for the prompt cache: none
   * of these live in the cached prefix (tools + system), which stays frozen
   * per ADR-0008. Switching MODEL is the exception — a cache is per-model, so
   * the next request necessarily re-writes it. Callers say so.
   */
  updateSettings(patch: Partial<ModelSettings>, capabilities?: ModelCapabilities): void {
    this.settings = { ...this.settings, ...patch };
    if (capabilities !== undefined) {
      this.capabilities = capabilities;
    }
    if (patch.model !== undefined) {
      this.ledger.setModel(patch.model);
    }
  }

  build(state: PipelineState): ModelRequest {
    const config = this.settings;
    const messages = [...state.messages];
    return {
      model: config.model,
      effort: config.effort,
      thinking: config.thinking,
      maxTokens: config.maxTokens,
      system: this.options.system,
      tools: this.options.tools,
      messages,
      cacheBreakpoints: breakpointsFor(messages.length, this.capabilities)
    };
  }

  observeUsage(usage: Usage): void {
    this.ledger.observe(usage);
  }

  totals(): LedgerTotals {
    return this.ledger.snapshot();
  }

  shouldCompact(): boolean {
    // Phase 2 replaces this implementation; Phase 1 never compacts.
    return false;
  }
}

export function breakpointsFor(messageCount: number, capabilities: ModelCapabilities): number[] {
  if (messageCount === 0) {
    return [];
  }
  // One breakpoint is spent on the system prefix; the rest are for messages.
  const available = Math.max(1, capabilities.maxCacheBreakpoints - 1);
  const points = new Set<number>([messageCount - 1]);
  if (available > 1 && messageCount > LOOKBACK_SAFETY_MESSAGES) {
    points.add(messageCount - 1 - LOOKBACK_SAFETY_MESSAGES);
  }
  return [...points].filter((index) => index >= 0).sort((a, b) => a - b);
}
