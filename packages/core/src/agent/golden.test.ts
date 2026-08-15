import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_DEFAULTS, type Config } from '../config/index.ts';
import { MockModelClient, type ScriptedTurn } from '../model/mock/client.ts';
import type { AgentEvent } from '../protocol/events.ts';
import type { PermissionChoice } from '../protocol/types.ts';
import { JsonlSessionStore } from '../session/store.ts';
import { eventSummary, stableEvents, stableText } from '../testing/golden.ts';
import { builtinToolRegistry } from '../tools/index.ts';
import { AgentSession } from './session.ts';

/**
 * Golden transcript suite (PHASE1-PLAN step 16). These run offline against a
 * scripted model in a temp workspace, and pin the PROTOCOL — so they are
 * client-agnostic: anything the TUI or headless client shows the user has to
 * come through here first.
 *
 * Regenerate deliberately with `bun run test -- -u` after reviewing the diff.
 */
let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'harness-golden-'));
  await writeFile(
    join(workspace, 'greet.js'),
    'function greet(n) { return "Hello, " + n; }\nconsole.log(greet("world"));\n',
    'utf8'
  );
  await writeFile(join(workspace, 'notes.md'), '# notes\nalpha\n', 'utf8');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

interface RunOptions {
  turns: ScriptedTurn[];
  prompt: string;
  config?: Partial<Config>;
  responder?: () => Promise<PermissionChoice>;
  abortAfterEvents?: number;
}

async function run(options: RunOptions): Promise<AgentEvent[]> {
  const controller = new AbortController();
  const session = new AgentSession({
    config: { ...CONFIG_DEFAULTS, ...options.config },
    modelClient: new MockModelClient(options.turns),
    workspaceRoot: workspace,
    sessionId: 'golden-session',
    tools: builtinToolRegistry(),
    environment: {
      workspaceRoot: workspace,
      platform: 'test',
      date: '2026-01-01',
      isGitRepo: false
    },
    retry: { attempts: 1, baseDelayMs: 1 },
    ...(options.responder !== undefined && { onPermissionRequest: options.responder })
  });

  const events: AgentEvent[] = [];
  for await (const event of session.run(options.prompt, controller.signal)) {
    events.push(event);
    if (options.abortAfterEvents !== undefined && events.length >= options.abortAfterEvents) {
      controller.abort();
    }
  }
  return events;
}

/** Snapshot both the readable summary and the full normalized stream. */
async function assertGolden(name: string, events: AgentEvent[]): Promise<void> {
  const payload = {
    // Both halves go through the same normalizer, or the readable summary
    // silently reintroduces host-specific paths the events already scrubbed.
    summary: eventSummary(events).map((line) => stableText(line, { workspaceRoot: workspace })),
    events: stableEvents(events, { workspaceRoot: workspace })
  };
  await expect(JSON.stringify(payload, null, 2)).toMatchFileSnapshot(
    `../../../../fixtures/golden/${name}.json`
  );
}

describe('golden transcripts', () => {
  it('01 read-only question with no tools', async () => {
    const events = await run({
      prompt: 'what is an agent loop?',
      turns: [{ thinking: 'simple question', text: 'A loop that calls tools until done.' }]
    });
    await assertGolden('01-plain-answer', events);
  });

  it('02 search then read', async () => {
    const events = await run({
      prompt: 'find the greet function',
      turns: [
        {
          toolCalls: [
            { id: 'c1', name: 'glob', input: { pattern: '**/*.js' } },
            { id: 'c2', name: 'read', input: { path: 'greet.js' } }
          ]
        },
        { text: 'greet.js defines greet(n).' }
      ]
    });
    await assertGolden('02-search-and-read', events);
  });

  it('03 single edit under acceptEdits', async () => {
    const events = await run({
      config: { permissionMode: 'acceptEdits' },
      prompt: 'add an exclamation mark',
      turns: [
        { toolCalls: [{ id: 'c1', name: 'read', input: { path: 'greet.js' } }] },
        {
          toolCalls: [
            {
              id: 'c2',
              name: 'edit',
              input: {
                path: 'greet.js',
                old_string: '"Hello, " + n',
                new_string: '"Hello, " + n + "!"'
              }
            }
          ]
        },
        { text: 'Added it.' }
      ]
    });
    await assertGolden('03-single-edit', events);
    expect(await readFile(join(workspace, 'greet.js'), 'utf8')).toContain('+ "!"');
  });

  it('04 bash failure then fix then verify', async () => {
    const events = await run({
      config: { permissionMode: 'bypass' },
      prompt: 'make the test pass',
      turns: [
        { toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'exit 3' } }] },
        { toolCalls: [{ id: 'c2', name: 'bash', input: { command: 'echo recovered' } }] },
        { text: 'Fixed and verified.' }
      ]
    });
    await assertGolden('04-bash-failure-then-fix', events);
  });

  it('05 permission denied with no approver (headless default)', async () => {
    const events = await run({
      prompt: 'edit the file',
      turns: [
        { toolCalls: [{ id: 'c1', name: 'read', input: { path: 'greet.js' } }] },
        {
          toolCalls: [
            {
              id: 'c2',
              name: 'edit',
              input: { path: 'greet.js', old_string: 'Hello', new_string: 'Hi' }
            }
          ]
        },
        { text: 'I could not apply that.' }
      ]
    });
    await assertGolden('05-permission-auto-denied', events);
    // The file must be untouched.
    expect(await readFile(join(workspace, 'greet.js'), 'utf8')).toContain('Hello');
  });

  it('06 permission granted for the session', async () => {
    const events = await run({
      prompt: 'edit twice',
      responder: () => Promise.resolve<PermissionChoice>('allow_session'),
      turns: [
        { toolCalls: [{ id: 'c1', name: 'read', input: { path: 'notes.md' } }] },
        {
          toolCalls: [
            {
              id: 'c2',
              name: 'edit',
              input: { path: 'notes.md', old_string: 'alpha', new_string: 'beta' }
            }
          ]
        },
        {
          toolCalls: [
            {
              id: 'c3',
              name: 'edit',
              input: { path: 'notes.md', old_string: 'beta', new_string: 'gamma' }
            }
          ]
        },
        { text: 'Both edits applied.' }
      ]
    });
    await assertGolden('06-permission-allow-session', events);
    // One ask only: the second edit rode the session grant.
    expect(events.filter((event) => event.type === 'permission_requested')).toHaveLength(1);
  });

  it('07 workspace escape is denied', async () => {
    const events = await run({
      config: { permissionMode: 'bypass' },
      prompt: 'read /etc/hosts',
      turns: [
        { toolCalls: [{ id: 'c1', name: 'read', input: { path: '../../../../etc/hosts' } }] },
        { text: 'That is outside the workspace.' }
      ]
    });
    await assertGolden('07-workspace-escape-denied', events);
  });

  it('08 unknown tool self-corrects', async () => {
    const events = await run({
      prompt: 'use the fake tool',
      turns: [
        { toolCalls: [{ id: 'c1', name: 'teleport', input: {} }] },
        { text: 'That tool does not exist; using read instead.' }
      ]
    });
    await assertGolden('08-unknown-tool', events);
  });

  it('09 invalid tool input self-corrects', async () => {
    const events = await run({
      prompt: 'read with bad args',
      turns: [
        { toolCalls: [{ id: 'c1', name: 'read', input: { wrong: true } }] },
        { text: 'Retrying with the right argument.' }
      ]
    });
    await assertGolden('09-invalid-tool-input', events);
  });

  it('10 refusal', async () => {
    const events = await run({
      prompt: 'do something disallowed',
      turns: [{ stopReason: 'refusal' }]
    });
    await assertGolden('10-refusal', events);
  });

  it('11 max_tokens', async () => {
    const events = await run({
      prompt: 'write forever',
      turns: [{ text: 'partial output', stopReason: 'max_tokens' }]
    });
    await assertGolden('11-max-tokens', events);
  });

  it('12 recoverable failure retried, then succeeds', async () => {
    const events = await run({
      prompt: 'flaky network',
      turns: [
        { failBeforeStart: { recoverable: true, message: 'api error 529: overloaded' } },
        { text: 'Recovered.' }
      ]
    });
    await assertGolden('12-retry-then-success', events);
  });

  it('13 resume replays prior history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-golden-store-'));
    try {
      const store = new JsonlSessionStore(dir);
      const created = await store.create({ workspaceRoot: workspace, model: 'claude-opus-5' });
      const first = AgentSession.fromEntries(created.entries, {
        config: { ...CONFIG_DEFAULTS },
        modelClient: new MockModelClient([{ text: 'first answer' }]),
        workspaceRoot: workspace,
        sink: created.sink
      });
      for await (const event of first.run('question one', new AbortController().signal)) {
        void event;
      }
      await created.sink.close();

      const opened = await store.open(created.sessionId);
      const client = new MockModelClient([{ text: 'second answer' }]);
      const resumed = AgentSession.fromEntries(opened.entries, {
        config: { ...CONFIG_DEFAULTS },
        modelClient: client,
        workspaceRoot: workspace,
        sink: opened.sink
      });
      const events: AgentEvent[] = [];
      for await (const event of resumed.run('question two', new AbortController().signal)) {
        events.push(event);
      }
      await opened.sink.close();

      await assertGolden('13-resume', events);
      // The replayed history is the contract resume exists for.
      expect(client.requests[0]?.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'question one' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'question two' }] }
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
