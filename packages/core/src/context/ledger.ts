import { estimateCostUsd } from '../model/pricing.ts';
import type { Usage } from '../protocol/types.ts';

/**
 * Token/cost ledger (R9). Every number comes from API usage fields — never
 * estimated locally (ADR-0008). Cache reads are tracked separately so the
 * cache-hit ratio is observable, which is how cache regressions get caught.
 */
export interface LedgerTotals extends Usage {
  requests: number;
  costUsd: number;
  /** cacheRead / (cacheRead + uncached input); 0 when there is no input yet. */
  cacheHitRatio: number;
}

const ZERO: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0
};

export class TokenLedger {
  private totals: Usage = { ...ZERO };
  private requests = 0;
  private cost = 0;

  constructor(private model: string) {}

  /**
   * Switch pricing for FUTURE observations. Cost already accrued keeps the
   * price it was billed at — re-pricing history against a model that did not
   * run it would be fiction.
   */
  setModel(model: string): void {
    this.model = model;
  }

  observe(usage: Usage): void {
    this.totals = {
      inputTokens: this.totals.inputTokens + usage.inputTokens,
      outputTokens: this.totals.outputTokens + usage.outputTokens,
      cacheReadInputTokens: this.totals.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        this.totals.cacheCreationInputTokens + usage.cacheCreationInputTokens
    };
    this.requests += 1;
    this.cost += estimateCostUsd(this.model, usage);
  }

  snapshot(): LedgerTotals {
    const billableInput = this.totals.inputTokens + this.totals.cacheReadInputTokens;
    return {
      ...this.totals,
      requests: this.requests,
      costUsd: this.cost,
      cacheHitRatio: billableInput === 0 ? 0 : this.totals.cacheReadInputTokens / billableInput
    };
  }
}
