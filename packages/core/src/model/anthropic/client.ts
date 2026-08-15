import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';

import { HarnessError, isHarnessError } from '../../errors/index.ts';
import type { ModelClient } from '../client.ts';
import type { ModelCapabilities, ModelRequest, ModelStreamEvent } from '../types.ts';
import { buildParams } from './params.ts';
import { transformMessageStream } from './transform.ts';

/**
 * The ONLY module allowed to import @anthropic-ai/sdk (boundary rule 3).
 * No retries here (maxRetries: 0) — backoff policy belongs to the loop.
 */
export interface AnthropicClientOptions {
  /** Defaults to the ANTHROPIC_API_KEY environment variable. */
  apiKey?: string;
  baseURL?: string;
}

const ALL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Models accepting mid-conversation {role:"system"} messages (cache-safe injection). */
const SYSTEM_ROLE_MODELS = /^claude-(opus-5|opus-4-8|fable-5|mythos-5)/;

function classifyError(cause: unknown): HarnessError {
  if (isHarnessError(cause)) {
    return cause;
  }
  if (
    cause instanceof APIUserAbortError ||
    (cause instanceof Error && cause.name === 'AbortError')
  ) {
    return new HarnessError('aborted', 'model request aborted', { cause });
  }
  if (cause instanceof APIConnectionError) {
    return new HarnessError('model_request_failed', `connection error: ${cause.message}`, {
      recoverable: true,
      cause
    });
  }
  if (cause instanceof APIError) {
    const status = typeof cause.status === 'number' ? cause.status : undefined;
    const recoverable =
      status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
    const retryAfterHeader = cause.headers?.get('retry-after');
    const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    return new HarnessError(
      'model_request_failed',
      `api error${status === undefined ? '' : ` ${status}`}: ${cause.message}`,
      {
        recoverable,
        cause,
        details: {
          status,
          ...(Number.isFinite(retryAfterSeconds) && { retryAfterMs: retryAfterSeconds * 1000 })
        }
      }
    );
  }
  return new HarnessError(
    'model_request_failed',
    `unexpected model client failure: ${String(cause)}`,
    {
      recoverable: false,
      cause
    }
  );
}

export function createAnthropicModelClient(options: AnthropicClientOptions = {}): ModelClient {
  const sdk = new Anthropic({
    maxRetries: 0,
    ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
    ...(options.baseURL !== undefined && { baseURL: options.baseURL })
  });

  return {
    provider: 'anthropic',

    capabilities(model: string): ModelCapabilities {
      return {
        systemRoleMessages: SYSTEM_ROLE_MODELS.test(model),
        adaptiveThinking: true,
        effortLevels: ALL_EFFORT_LEVELS,
        maxCacheBreakpoints: 4
      };
    },

    async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
      let raw: AsyncIterable<unknown>;
      try {
        raw = await sdk.messages.create({ ...buildParams(request), stream: true }, { signal });
      } catch (cause) {
        throw classifyError(cause);
      }
      try {
        yield* transformMessageStream(raw);
      } catch (cause) {
        throw classifyError(cause);
      }
    },

    async countTokens(request: ModelRequest): Promise<number> {
      const params = buildParams(request);
      try {
        const result = await sdk.messages.countTokens({
          model: params.model,
          messages: params.messages,
          ...(params.system !== undefined && { system: params.system }),
          ...(params.tools !== undefined && { tools: params.tools })
        });
        return result.input_tokens;
      } catch (cause) {
        throw classifyError(cause);
      }
    }
  };
}
