import type { ModelCapabilities, ModelRequest, ModelStreamEvent } from './types.ts';

/**
 * The provider boundary (ADR-0001/0010). Implementations convert a normalized
 * request into a normalized event stream — nothing else.
 *
 * Contract:
 *  - No retry policy here; failures throw `HarnessError` and the loop decides.
 *    Recoverable failures (429/5xx/network) carry `recoverable: true` and may
 *    carry `details.retryAfterMs`. User cancellation throws code 'aborted'.
 *  - No vendor types cross this boundary in either direction.
 *  - Streaming always; the final `message_stop` event carries the complete
 *    accumulated assistant content.
 */
export interface ModelClient {
  readonly provider: string;
  capabilities(model: string): ModelCapabilities;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
  /** Optional; backed by the provider's token-counting endpoint (never tiktoken). */
  countTokens?(request: ModelRequest): Promise<number>;
}
