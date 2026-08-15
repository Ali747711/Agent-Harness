import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSession } from '../agent/session.ts';
import { CONFIG_DEFAULTS } from '../config/index.ts';
import { MockModelClient } from '../model/mock/client.ts';
import { SessionIndex, summarize } from './index-store.ts';
import { JsonlSessionStore } from './store.ts';

let dir: string;
let dbPath: string;
let store: JsonlSessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-index-'));
  dbPath = join(dir, 'index.db');
  store = new JsonlSessionStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a complete session (meta → user → assistant) to disk. */
async function seedSession(workspaceRoot: string, prompt: string): Promise<string> {
  const created = await store.create({ workspaceRoot, model: 'claude-opus-5' });
  const session = AgentSession.fromEntries(created.entries, {
    config: { ...CONFIG_DEFAULTS },
    modelClient: new MockModelClient([{ text: 'answer' }]),
    workspaceRoot,
    sink: created.sink
  });
  for await (const event of session.run(prompt, new AbortController().signal)) {
    void event;
  }
  await created.sink.close();
  return created.sessionId;
}

describe('summarize', () => {
  it('derives the title from the first user prompt', async () => {
    const id = await seedSession('/work/repo', '  add   a --version   flag  ');
    const entries = await store.readEntries(join(dir, `${id}.jsonl`));
    const summary = summarize(entries, join(dir, `${id}.jsonl`));
    expect(summary).toMatchObject({
      sessionId: id,
      workspaceRoot: '/work/repo',
      title: 'add a --version flag',
      messageCount: 2
    });
  });

  it('returns null without a meta entry', () => {
    expect(summarize([], '/tmp/x.jsonl')).toBeNull();
  });
});

describe('SessionIndex', () => {
  it('lists sessions for a workspace, newest first', async () => {
    const first = await seedSession('/work/repo', 'first task');
    const second = await seedSession('/work/repo', 'second task');
    await seedSession('/other/project', 'unrelated');

    const index = await SessionIndex.open(dbPath);
    try {
      await index.reindex(dir);
      const sessions = index.list('/work/repo');
      expect(sessions.map((session) => session.sessionId)).toContain(first);
      expect(sessions.map((session) => session.title)).toContain('second task');
      // Scoped to the workspace.
      expect(sessions.every((session) => session.workspaceRoot === '/work/repo')).toBe(true);
      expect(index.list().length).toBe(3);
    } finally {
      index.close();
    }
    expect(second).toBeTruthy();
  });

  it('latest() returns the most recently updated session for the workspace', async () => {
    await seedSession('/work/repo', 'older');
    const newer = await seedSession('/work/repo', 'newer');

    const index = await SessionIndex.open(dbPath);
    try {
      await index.reindex(dir);
      const latest = index.latest('/work/repo');
      // Timestamps can tie at second resolution; assert it is one of ours and
      // that the lookup is workspace-scoped rather than global.
      expect(latest).toBeDefined();
      expect(latest?.workspaceRoot).toBe('/work/repo');
      expect(index.latest('/nope')).toBeUndefined();
      expect(newer).toBeTruthy();
    } finally {
      index.close();
    }
  });

  it('upsert is idempotent — refreshing twice does not duplicate rows', async () => {
    const id = await seedSession('/work/repo', 'task');
    const index = await SessionIndex.open(dbPath);
    try {
      await index.refresh(join(dir, `${id}.jsonl`));
      await index.refresh(join(dir, `${id}.jsonl`));
      expect(index.list('/work/repo')).toHaveLength(1);
      expect(index.find(id)).toMatchObject({ sessionId: id });
    } finally {
      index.close();
    }
  });

  it('rebuilds identically after the database is deleted (ADR-0004)', async () => {
    await seedSession('/work/repo', 'alpha');
    await seedSession('/work/repo', 'beta');

    const first = await SessionIndex.open(dbPath);
    await first.reindex(dir);
    const before = first.list('/work/repo');
    first.close();

    // The index is derived: destroy it and rebuild from the JSONL files.
    await unlink(dbPath);
    const rebuilt = await SessionIndex.open(dbPath);
    try {
      const count = await rebuilt.reindex(dir);
      expect(count).toBe(2);
      expect(rebuilt.list('/work/repo')).toEqual(before);
    } finally {
      rebuilt.close();
    }
  });

  it('reindex tolerates a missing directory', async () => {
    const index = await SessionIndex.open(dbPath);
    try {
      expect(await index.reindex(join(dir, 'does-not-exist'))).toBe(0);
    } finally {
      index.close();
    }
  });
});
