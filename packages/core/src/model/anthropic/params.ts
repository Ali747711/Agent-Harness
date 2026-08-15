import type Anthropic from '@anthropic-ai/sdk';

import type { ModelMessage, ModelRequest } from '../types.ts';

/**
 * ModelRequest → Anthropic wire params (streaming flag added at the call
 * site). Pure and exported for direct testing.
 *
 * Cache discipline (ADR-0008): system blocks flagged `cache: true` get a
 * cache_control marker; `cacheBreakpoints` message indices get one on their
 * last content block. Placement counts are the ContextPipeline's job — this
 * function just maps faithfully.
 */
type WireContentBlock = Extract<Anthropic.ContentBlockParam, { type: string }>;

const EPHEMERAL = { type: 'ephemeral' } as const;

function mapMessage(message: ModelMessage): Anthropic.MessageParam {
  if (message.role === 'system') {
    // Mid-conversation operator instruction (capability-gated by the caller).
    return { role: 'system', content: message.content } as unknown as Anthropic.MessageParam;
  }
  const content: WireContentBlock[] = message.content.map((block): WireContentBlock => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'thinking':
        // Signature must be echoed verbatim; empty string is valid (display: omitted).
        return { type: 'thinking', thinking: block.thinking, signature: block.signature ?? '' };
      case 'redacted_thinking':
        return { type: 'redacted_thinking', data: block.data };
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError !== undefined && { is_error: block.isError })
        };
      default: {
        const exhaustive: never = block;
        throw new Error(`unreachable content block: ${JSON.stringify(exhaustive)}`);
      }
    }
  });
  return { role: message.role, content };
}

function attachBreakpoint(mapped: Anthropic.MessageParam): void {
  if (typeof mapped.content === 'string' || mapped.content.length === 0) {
    return; // system-role or empty message — not a cacheable anchor
  }
  const last = mapped.content[mapped.content.length - 1];
  if (
    last !== undefined &&
    (last.type === 'text' || last.type === 'tool_result' || last.type === 'tool_use')
  ) {
    (last as { cache_control?: typeof EPHEMERAL }).cache_control = EPHEMERAL;
  }
}

export function buildParams(request: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  const messages = request.messages.map(mapMessage);
  for (const index of request.cacheBreakpoints ?? []) {
    const target = messages[index];
    if (target !== undefined) {
      attachBreakpoint(target);
    }
  }

  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system.map((block) => ({
      type: 'text',
      text: block.text,
      ...(block.cache === true && { cache_control: EPHEMERAL })
    })),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
      ...(tool.strict !== undefined && { strict: tool.strict })
    })),
    messages,
    // Adaptive thinking with visible summaries (the default display is
    // 'omitted' on current Opus-class models — R1 wants visible thinking).
    thinking:
      request.thinking === 'adaptive'
        ? { type: 'adaptive', display: 'summarized' }
        : { type: 'disabled' },
    output_config: { effort: request.effort }
  };
}
