import { describe, expect, it } from 'vitest';

import type { ModelRequest } from '../types.ts';
import { buildParams } from './params.ts';

function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'claude-opus-5',
    effort: 'xhigh',
    thinking: 'adaptive',
    maxTokens: 32_000,
    system: [{ text: 'You are a coding agent.', cache: true }],
    tools: [
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        strict: true
      }
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides
  };
}

describe('buildParams', () => {
  it('maps thinking/effort per ADR-0010 (adaptive + summarized display)', () => {
    const params = buildParams(baseRequest());
    expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(params.output_config).toEqual({ effort: 'xhigh' });
    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(32_000);
    // Sampling params are not representable — assert they never leak in.
    expect('temperature' in params).toBe(false);
    expect('top_p' in params).toBe(false);
  });

  it('maps disabled thinking', () => {
    const params = buildParams(baseRequest({ thinking: 'disabled' }));
    expect(params.thinking).toEqual({ type: 'disabled' });
  });

  it('places cache_control on flagged system blocks only', () => {
    const params = buildParams(
      baseRequest({ system: [{ text: 'stable' }, { text: 'prefix-end', cache: true }] })
    );
    expect(params.system).toEqual([
      { type: 'text', text: 'stable' },
      { type: 'text', text: 'prefix-end', cache_control: { type: 'ephemeral' } }
    ]);
  });

  it('passes tools through with strict + schema untouched', () => {
    const params = buildParams(baseRequest());
    expect(params.tools).toEqual([
      {
        name: 'read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        strict: true
      }
    ]);
  });

  it('maps every message and block kind', () => {
    const params = buildParams(
      baseRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'do it' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'plan', signature: 'sig' },
              { type: 'redacted_thinking', data: 'blob' },
              { type: 'text', text: 'running tool' },
              { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 't1', content: 'file body', isError: false }
            ]
          },
          { role: 'system', content: 'Terse mode enabled.' }
        ]
      })
    );
    expect(params.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan', signature: 'sig' },
          { type: 'redacted_thinking', data: 'blob' },
          { type: 'text', text: 'running tool' },
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false }]
      },
      { role: 'system', content: 'Terse mode enabled.' }
    ]);
  });

  it('attaches message-tail cache breakpoints by index and skips system-role targets', () => {
    const params = buildParams(
      baseRequest({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q1' }] },
          { role: 'system', content: 'note' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'part 1' },
              { type: 'text', text: 'part 2' }
            ]
          }
        ],
        cacheBreakpoints: [1, 2, 99]
      })
    );
    const [first, second, third] = params.messages;
    expect(JSON.stringify(first)).not.toContain('cache_control');
    expect(JSON.stringify(second)).not.toContain('cache_control');
    expect(third?.content).toEqual([
      { type: 'text', text: 'part 1' },
      { type: 'text', text: 'part 2', cache_control: { type: 'ephemeral' } }
    ]);
  });
});
