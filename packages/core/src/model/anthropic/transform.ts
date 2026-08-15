import { HarnessError } from '../../errors/index.ts';
import { StopReasonSchema, type Usage } from '../../protocol/index.ts';
import type { AssistantBlock, ModelStreamEvent } from '../types.ts';

/**
 * Raw Anthropic SSE events → normalized ModelStreamEvents, with content
 * accumulation. Deliberately structural (not SDK-typed) so recorded cassettes
 * (fixtures/cassettes/*.jsonl) replay through the exact production path.
 * Unknown event and delta types are skipped — forward compatibility at the
 * wire boundary is defensive, never a crash.
 */
type RawEvent = { type: string } & Record<string, unknown>;

interface RawUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

type BlockBuilder =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted_thinking'; data: string }
  | { kind: 'tool_use'; id: string; name: string; jsonParts: string[] };

function protocolViolation(message: string, details?: unknown): HarnessError {
  return new HarnessError('model_request_failed', `provider stream violation: ${message}`, {
    recoverable: false,
    details
  });
}

function mergeUsage(base: Usage, raw: RawUsage | undefined): Usage {
  if (!raw) {
    return base;
  }
  return {
    inputTokens: raw.input_tokens ?? base.inputTokens,
    outputTokens: raw.output_tokens ?? base.outputTokens,
    cacheReadInputTokens: raw.cache_read_input_tokens ?? base.cacheReadInputTokens,
    cacheCreationInputTokens: raw.cache_creation_input_tokens ?? base.cacheCreationInputTokens
  };
}

function finalizeBlock(builder: BlockBuilder): AssistantBlock {
  switch (builder.kind) {
    case 'text':
      return { type: 'text', text: builder.text };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: builder.thinking,
        ...(builder.signature !== '' && { signature: builder.signature })
      };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: builder.data };
    case 'tool_use': {
      const json = builder.jsonParts.join('');
      let input: Record<string, unknown>;
      try {
        input = json === '' ? {} : (JSON.parse(json) as Record<string, unknown>);
      } catch (cause) {
        throw protocolViolation(`malformed tool_use input JSON for ${builder.name}`, { cause });
      }
      return { type: 'tool_use', id: builder.id, name: builder.name, input };
    }
  }
}

export async function* transformMessageStream(
  rawEvents: AsyncIterable<unknown>
): AsyncGenerator<ModelStreamEvent> {
  const builders = new Map<number, BlockBuilder>();
  const completedOrder: number[] = [];
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  };
  let stopReason: string | null = null;
  let sawStart = false;

  for await (const item of rawEvents) {
    if (item === null || typeof item !== 'object' || typeof (item as RawEvent).type !== 'string') {
      throw protocolViolation('non-object stream event', { item });
    }
    const event = item as RawEvent;

    switch (event.type) {
      case 'message_start': {
        sawStart = true;
        const message = event.message as { model?: string; usage?: RawUsage } | undefined;
        usage = mergeUsage(usage, message?.usage);
        yield { type: 'message_start', model: message?.model ?? 'unknown' };
        break;
      }

      case 'content_block_start': {
        const index = event.index as number;
        const block = event.content_block as { type: string } & Record<string, unknown>;
        switch (block.type) {
          case 'text':
            builders.set(index, { kind: 'text', text: (block.text as string) ?? '' });
            break;
          case 'thinking':
            builders.set(index, {
              kind: 'thinking',
              thinking: (block.thinking as string) ?? '',
              signature: ''
            });
            break;
          case 'redacted_thinking':
            builders.set(index, {
              kind: 'redacted_thinking',
              data: (block.data as string) ?? ''
            });
            break;
          case 'tool_use': {
            const builder: BlockBuilder = {
              kind: 'tool_use',
              id: block.id as string,
              name: block.name as string,
              jsonParts: []
            };
            builders.set(index, builder);
            yield { type: 'tool_use_start', id: builder.id, name: builder.name };
            break;
          }
          default:
            // Unknown block kinds are tolerated and dropped from content.
            break;
        }
        break;
      }

      case 'content_block_delta': {
        const index = event.index as number;
        const builder = builders.get(index);
        const delta = event.delta as { type: string } & Record<string, unknown>;
        if (builder === undefined) {
          break; // delta for a block kind we chose to ignore
        }
        switch (delta.type) {
          case 'text_delta': {
            const text = delta.text as string;
            if (builder.kind === 'text') {
              builder.text += text;
            }
            yield { type: 'text_delta', text };
            break;
          }
          case 'thinking_delta': {
            const text = delta.thinking as string;
            if (builder.kind === 'thinking') {
              builder.thinking += text;
            }
            yield { type: 'thinking_delta', text };
            break;
          }
          case 'input_json_delta': {
            const partialJson = delta.partial_json as string;
            if (builder.kind === 'tool_use') {
              builder.jsonParts.push(partialJson);
              yield { type: 'tool_use_input_delta', id: builder.id, partialJson };
            }
            break;
          }
          case 'signature_delta': {
            if (builder.kind === 'thinking') {
              builder.signature += delta.signature as string;
            }
            break;
          }
          default:
            break; // unknown delta types tolerated
        }
        break;
      }

      case 'content_block_stop': {
        const index = event.index as number;
        const builder = builders.get(index);
        if (builder !== undefined) {
          completedOrder.push(index);
          if (builder.kind === 'tool_use') {
            const finalized = finalizeBlock(builder);
            if (finalized.type === 'tool_use') {
              yield {
                type: 'tool_use_complete',
                id: finalized.id,
                name: finalized.name,
                input: finalized.input
              };
            }
          }
        }
        break;
      }

      case 'message_delta': {
        const delta = event.delta as { stop_reason?: string | null } | undefined;
        if (delta?.stop_reason != null) {
          stopReason = delta.stop_reason;
        }
        usage = mergeUsage(usage, event.usage as RawUsage | undefined);
        break;
      }

      case 'message_stop': {
        if (!sawStart) {
          throw protocolViolation('message_stop before message_start');
        }
        const parsed = StopReasonSchema.safeParse(stopReason);
        if (!parsed.success) {
          throw protocolViolation(`missing or unknown stop_reason: ${String(stopReason)}`);
        }
        const content = completedOrder
          .sort((a, b) => a - b)
          .map((index) => builders.get(index))
          .filter((builder): builder is BlockBuilder => builder !== undefined)
          .map(finalizeBlock);
        yield { type: 'message_stop', stopReason: parsed.data, usage, content };
        return;
      }

      default:
        break; // ping, fine-grained events, future types — ignore
    }
  }

  throw protocolViolation('stream ended without message_stop');
}
