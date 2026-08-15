import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CONFIG_DEFAULTS } from '../config/index.ts';
import { HarnessError } from '../errors/index.ts';
import { MockModelClient, type ScriptedTurn } from '../model/mock/client.ts';
import type { AgentEvent } from '../protocol/events.ts';
import { JsonlSessionStore } from '../session/store.ts';
import { builtinToolRegistry, defineTool, ToolRegistry } from '../tools/index.ts';
import { AgentSession } from './session.ts';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'harness-toolloop-'));
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'a.txt'), 'hi\nthere\n', 'utf8');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function session(turns: ScriptedTurn[], tools = builtinToolRegistry()) {
  const client = new MockModelClient(turns);
  const agent = new AgentSession({
    config: { ...CONFIG_DEFAULTS },
    modelClient: client,
    workspaceRoot: workspace,
    sessionId: 'sess-tools',
    tools,
    retry: { attempts: 1, baseDelayMs: 1 }
  });
  return { agent, client };
}

async function collect(
  agent: AgentSession,
  prompt: string,
  signal: AbortSignal = new AbortController().signal
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(prompt, signal)) {
    events.push(event);
  }
  return events;
}

describe('tool execution in the loop (step 7)', () => {
  it('runs a read tool call and feeds the numbered content back (golden flow)', async () => {
    const { agent, client } = session([
      { toolCalls: [{ name: 'read', input: { path: 'a.txt' } }] },
      { text: 'the file greets you' }
    ]);
    const events = await collect(agent, 'what does a.txt say?');

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'turn_started',
      'tool_call_started',
      'tool_call_completed',
      'assistant_text_delta',
      'turn_completed',
      'session_idle'
    ]);
    expect(events.find((event) => event.type === 'tool_call_started')).toMatchObject({
      tool: 'read',
      title: 'Read a.txt'
    });
    expect(events.find((event) => event.type === 'tool_call_completed')).toMatchObject({
      ok: true,
      summary: 'read 2 of 2 lines'
    });

    // The model received the tool result verbatim on the follow-up request.
    expect(client.requests).toHaveLength(2);
    const followUp = client.requests[1]?.messages.at(-1);
    const block = followUp?.role === 'user' ? followUp.content[0] : undefined;
    if (block?.type === 'tool_result') {
      expect(block.content).toBe('1→hi\n2→there');
      expect(block.isError).toBeUndefined();
    } else {
      expect.unreachable('expected a tool_result block');
    }

    // Wire specs were sent on both requests, byte-identical (cache stability).
    expect(JSON.stringify(client.requests[0]?.tools)).toBe(
      JSON.stringify(client.requests[1]?.tools)
    );
    expect(client.requests[0]?.tools.map((tool) => tool.name)).toEqual(['glob', 'read']);

    // Usage summed across both segments of the turn.
    expect(events.find((event) => event.type === 'turn_completed')?.usage.inputTokens).toBe(200);
  });

  it('returns validation errors as tool_results the model can react to', async () => {
    const { agent, client } = session([
      { toolCalls: [{ name: 'read', input: {} }] },
      { text: 'let me fix that call' }
    ]);
    const events = await collect(agent, 'go');

    const completed = events.find((event) => event.type === 'tool_call_completed');
    expect(completed).toMatchObject({ ok: false });
    const followUp = client.requests[1]?.messages.at(-1);
    const block = followUp?.role === 'user' ? followUp.content[0] : undefined;
    if (block?.type === 'tool_result') {
      expect(block.isError).toBe(true);
      expect(block.content).toContain('invalid input for read');
      expect(block.content).toContain('path');
    } else {
      expect.unreachable('expected a tool_result block');
    }
  });

  it('fails closed on non-readOnly tools until the permission engine exists', async () => {
    const registry = new ToolRegistry().register(
      defineTool<{ path: string }>({
        name: 'write_stub',
        description: 'stub writer',
        schema: z.strictObject({ path: z.string() }),
        readOnly: false,
        renderTitle: (input) => `Write ${input.path}`,
        plan: (input) => ({
          tool: 'write_stub',
          title: `Write ${input.path}`,
          effects: [{ kind: 'write', path: input.path }]
        }),
        execute: () => Promise.resolve({ ok: true, content: 'should never run', summary: 'never' })
      })
    );
    const { agent, client } = session(
      [{ toolCalls: [{ name: 'write_stub', input: { path: 'x' } }] }, { text: 'understood' }],
      registry
    );
    const events = await collect(agent, 'write something');

    expect(events.find((event) => event.type === 'tool_call_completed')).toMatchObject({
      ok: false
    });
    const followUp = client.requests[1]?.messages.at(-1);
    const block = followUp?.role === 'user' ? followUp.content[0] : undefined;
    if (block?.type === 'tool_result') {
      expect(block.content).toContain('requires permissions');
    }
  });

  it('denies path escapes via the workspace guard', async () => {
    const { agent, client } = session([
      { toolCalls: [{ name: 'read', input: { path: '../outside.txt' } }] },
      { text: 'staying inside' }
    ]);
    await collect(agent, 'read outside');
    const followUp = client.requests[1]?.messages.at(-1);
    const block = followUp?.role === 'user' ? followUp.content[0] : undefined;
    if (block?.type === 'tool_result') {
      expect(block.isError).toBe(true);
      expect(block.content).toContain('outside the workspace');
    } else {
      expect.unreachable('expected a tool_result block');
    }
  });

  it('closes the transcript with interrupted results on mid-batch abort', async () => {
    const controller = new AbortController();
    const aborter = defineTool<Record<string, never>>({
      name: 'aborter',
      description: 'aborts the run mid-execution',
      schema: z.strictObject({}),
      readOnly: true,
      renderTitle: () => 'Abort trigger',
      plan: () => ({ tool: 'aborter', title: 'Abort trigger', effects: [] }),
      execute: () => {
        controller.abort();
        return Promise.reject(new HarnessError('aborted', 'aborted mid-tool'));
      }
    });
    const registry = builtinToolRegistry().register(aborter);
    const { agent, client } = session(
      [
        {
          toolCalls: [
            { id: 'c1', name: 'aborter', input: {} },
            { id: 'c2', name: 'read', input: { path: 'a.txt' } }
          ]
        }
      ],
      registry
    );

    const events = await collect(agent, 'go', controller.signal);

    // No follow-up model request; quiet idle.
    expect(client.requests).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'session_idle' });
    expect(events.some((event) => event.type === 'error')).toBe(false);

    // Both pending calls got explicit interrupted results (no dangling tool_use).
    const results = agent.messages.at(-1);
    const ids =
      results?.role === 'user'
        ? results.content.map((block) =>
            block.type === 'tool_result' ? block.toolUseId : block.type
          )
        : [];
    expect(ids).toEqual(['c1', 'c2']);
  });

  it('persists tool turns as user tool_result entries (replayable transcript)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-toolstore-'));
    try {
      const store = new JsonlSessionStore(dir);
      const created = await store.create({ workspaceRoot: workspace, model: 'claude-opus-5' });
      const client = new MockModelClient([
        { toolCalls: [{ name: 'read', input: { path: 'a.txt' } }] },
        { text: 'done' }
      ]);
      const agent = AgentSession.fromEntries(created.entries, {
        config: { ...CONFIG_DEFAULTS },
        modelClient: client,
        workspaceRoot: workspace,
        tools: builtinToolRegistry(),
        sink: created.sink
      });
      for await (const event of agent.run('read a.txt', new AbortController().signal)) {
        void event;
      }
      await created.sink.close();

      const reopened = await store.open(created.sessionId);
      await reopened.sink.close();
      expect(reopened.entries.map((entry) => entry.type)).toEqual([
        'meta',
        'user',
        'assistant',
        'user',
        'assistant'
      ]);
      const toolTurn = reopened.entries[2];
      if (toolTurn?.type === 'assistant') {
        expect(toolTurn.data.stopReason).toBe('tool_use');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
