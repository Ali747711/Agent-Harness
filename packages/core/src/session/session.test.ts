import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSession } from '../agent/session.ts';
import { CONFIG_DEFAULTS } from '../config/index.ts';
import { isHarnessError } from '../errors/index.ts';
import { MockModelClient } from '../model/mock/client.ts';
import { makeEntry, resolvePath, type SessionEntry, toModelMessages } from './entries.ts';
import { projectSlug } from './paths.ts';
import { JsonlSessionStore } from './store.ts';

let dir: string;
let store: JsonlSessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-session-'));
  store = new JsonlSessionStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function chain(): {
  entries: SessionEntry[];
  ids: { meta: string; u1: string; a1: string; s1: string; s2: string; u2: string };
} {
  const meta = makeEntry(
    { parentId: null },
    {
      type: 'meta',
      data: { sessionId: 's1', workspaceRoot: '/w', model: 'claude-opus-5', createdAt: 'now' }
    }
  );
  const u1 = makeEntry(
    { parentId: meta.id },
    { type: 'user', data: { content: [{ type: 'text', text: 'first' }] } }
  );
  const a1 = makeEntry(
    { parentId: u1.id },
    {
      type: 'assistant',
      data: {
        content: [{ type: 'text', text: 'reply' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        }
      }
    }
  );
  // Subagent branch (ADR-0005 reservation): internals stay out of root scope.
  const s1 = makeEntry(
    { parentId: a1.id, agentId: 'sub-1', parentAgentId: 'root' },
    { type: 'user', data: { content: [{ type: 'text', text: 'subtask' }] } }
  );
  const s2 = makeEntry(
    { parentId: s1.id, agentId: 'sub-1', parentAgentId: 'root' },
    {
      type: 'assistant',
      data: {
        content: [{ type: 'text', text: 'sub result' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0
        }
      }
    }
  );
  const u2 = makeEntry(
    { parentId: a1.id },
    { type: 'user', data: { content: [{ type: 'text', text: 'second' }] } }
  );
  return {
    entries: [meta, u1, a1, s1, s2, u2],
    ids: { meta: meta.id, u1: u1.id, a1: a1.id, s1: s1.id, s2: s2.id, u2: u2.id }
  };
}

describe('entries: resolvePath + toModelMessages', () => {
  it('resolves the root path, excluding subagent internals', () => {
    const { entries, ids } = chain();
    const path = resolvePath(entries);
    expect(path.map((entry) => entry.id)).toEqual([ids.meta, ids.u1, ids.a1, ids.u2]);
  });

  it('resolves a subagent scope from its leaf', () => {
    const { entries, ids } = chain();
    const path = resolvePath(entries, ids.s2, 'sub-1');
    expect(path.map((entry) => entry.id)).toEqual([ids.s1, ids.s2]);
  });

  it('maps resolved entries to model messages, skipping meta', () => {
    const { entries } = chain();
    const messages = toModelMessages(resolvePath(entries));
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] }
    ]);
  });

  it('returns [] for an unknown scope', () => {
    const { entries } = chain();
    expect(resolvePath(entries, undefined, 'nope')).toEqual([]);
  });
});

describe('JsonlSessionStore', () => {
  it('create → append → open round-trips entries in order', async () => {
    const created = await store.create({ workspaceRoot: '/w', model: 'claude-opus-5' });
    const user = makeEntry(
      { parentId: created.entries[0]?.id ?? null },
      { type: 'user', data: { content: [{ type: 'text', text: 'hi' }] } }
    );
    await created.sink.append(user);
    await created.sink.flush();
    await created.sink.close();

    const opened = await store.open(created.sessionId);
    await opened.sink.close();
    expect(opened.entries.map((entry) => entry.type)).toEqual(['meta', 'user']);
    expect(opened.entries[1]).toEqual(user);
  });

  it('tolerates a truncated trailing line (crash mid-write)', async () => {
    const created = await store.create({ workspaceRoot: '/w', model: 'm' });
    await created.sink.close();
    await appendFile(created.filePath, '{"v":1,"id":"partial', 'utf8');

    const opened = await store.open(created.sessionId);
    await opened.sink.close();
    expect(opened.entries).toHaveLength(1);
    expect(opened.entries[0]?.type).toBe('meta');
  });

  it('rejects corruption that is not at the tail', async () => {
    const created = await store.create({ workspaceRoot: '/w', model: 'm' });
    await created.sink.close();
    await appendFile(created.filePath, 'not json at all\n{"also":"not an entry"}\n', 'utf8');

    await expect(store.open(created.sessionId)).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.code === 'session_corrupt'
    );
  });

  it('rejects schema-invalid entries as corruption', async () => {
    const created = await store.create({ workspaceRoot: '/w', model: 'm' });
    await created.sink.close();
    await writeFile(created.filePath, '{"v":1,"type":"user"}\n{"x":1}\n', 'utf8');
    await expect(store.open(created.sessionId)).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.code === 'session_corrupt'
    );
  });

  it('throws session_not_found for unknown ids', async () => {
    await expect(store.open('missing-id')).rejects.toSatisfy(
      (error: unknown) => isHarnessError(error) && error.code === 'session_not_found'
    );
  });
});

describe('AgentSession persistence integration', () => {
  it('a text turn persists meta → user → assistant with a linked chain', async () => {
    const created = await store.create({ workspaceRoot: '/w', model: 'claude-opus-5' });
    const session = AgentSession.fromEntries(created.entries, {
      config: { ...CONFIG_DEFAULTS },
      modelClient: new MockModelClient([{ text: 'persisted answer' }]),
      workspaceRoot: '/w',
      sink: created.sink
    });

    for await (const event of session.run('hello', new AbortController().signal)) {
      void event;
    }
    await created.sink.close();

    const opened = await store.open(created.sessionId);
    await opened.sink.close();
    const [meta, user, assistant] = opened.entries;
    expect(opened.entries.map((entry) => entry.type)).toEqual(['meta', 'user', 'assistant']);
    expect(user?.parentId).toBe(meta?.id);
    expect(assistant?.parentId).toBe(user?.id);
    if (assistant?.type === 'assistant') {
      expect(assistant.data.stopReason).toBe('end_turn');
      expect(assistant.data.content).toEqual([{ type: 'text', text: 'persisted answer' }]);
    }
    expect(session.sessionId).toBe(created.sessionId);
  });

  it('resume replays the exact prior history to the model (R5)', async () => {
    // Session 1: one full turn, then "the process dies".
    const created = await store.create({ workspaceRoot: '/w', model: 'claude-opus-5' });
    const first = AgentSession.fromEntries(created.entries, {
      config: { ...CONFIG_DEFAULTS },
      modelClient: new MockModelClient([{ text: 'first answer' }]),
      workspaceRoot: '/w',
      sink: created.sink
    });
    for await (const event of first.run('question one', new AbortController().signal)) {
      void event;
    }
    await created.sink.close();

    // Session 2: resume from disk with a fresh client.
    const client = new MockModelClient([{ text: 'second answer' }]);
    const opened = await store.open(created.sessionId);
    const resumed = AgentSession.fromEntries(opened.entries, {
      config: { ...CONFIG_DEFAULTS },
      modelClient: client,
      workspaceRoot: '/w',
      sink: opened.sink
    });
    const events = [];
    for await (const event of resumed.run('question two', new AbortController().signal)) {
      events.push(event);
    }
    await opened.sink.close();

    expect(events).toContainEqual({ type: 'turn_started', turn: 2 });
    expect(client.requests[0]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'question one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'question two' }] }
    ]);

    // And the resumed turn was itself persisted.
    const reopened = await store.open(created.sessionId);
    await reopened.sink.close();
    expect(reopened.entries.map((entry) => entry.type)).toEqual([
      'meta',
      'user',
      'assistant',
      'user',
      'assistant'
    ]);
  });

  it('surfaces sink failures as fatal, legible errors', async () => {
    const session = new AgentSession({
      config: { ...CONFIG_DEFAULTS },
      modelClient: new MockModelClient([{ text: 'x' }]),
      workspaceRoot: '/w',
      sink: {
        append: () => Promise.reject(new Error('disk full')),
        flush: () => Promise.resolve(),
        close: () => Promise.resolve()
      }
    });
    const events = [];
    for await (const event of session.run('go', new AbortController().signal)) {
      events.push(event);
    }
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      severity: 'fatal',
      code: 'session_write_failed'
    });
    expect(events.at(-1)).toEqual({ type: 'session_idle' });
  });
});

describe('paths', () => {
  it('slugs are stable, sanitized, and collision-resistant', () => {
    expect(projectSlug('/a/b/My Repo!!')).toBe(projectSlug('/a/b/My Repo!!'));
    expect(projectSlug('/a/b/My Repo!!')).toMatch(/^my-repo-[0-9a-f]{8}$/);
    expect(projectSlug('/x/repo')).not.toBe(projectSlug('/y/repo'));
  });
});
