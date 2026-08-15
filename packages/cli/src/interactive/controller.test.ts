import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSession, builtinToolRegistry, CONFIG_DEFAULTS, MockModelClient } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ViewModel } from '../state/view-model.ts';
import { SessionController } from './controller.ts';

let workspace: string;

beforeEach(async () => {
  // A real directory: the workspace guard canonicalizes against it, so tool
  // calls must resolve for real before the permission gate is reached.
  workspace = await mkdtemp(join(tmpdir(), 'harness-controller-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function build(turns: Parameters<MockModelClient['script']>[0], config = {}) {
  const client = new MockModelClient(turns);
  const controller: SessionController = new SessionController({
    session: new AgentSession({
      config: { ...CONFIG_DEFAULTS, ...config },
      modelClient: client,
      workspaceRoot: workspace,
      tools: builtinToolRegistry(),
      onPermissionRequest: () => controller.permissionResponder()
    }),
    model: 'claude-opus-5',
    workspaceRoot: workspace
  });
  return { controller, client };
}

/** Wait until a predicate holds, so tests never race the async drain loop. */
async function until(
  controller: SessionController,
  predicate: (vm: ViewModel) => boolean,
  timeoutMs = 2000
): Promise<ViewModel> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(controller.state)) {
      return controller.state;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not met; last status=${controller.state.status}`);
}

describe('SessionController', () => {
  it('submits a prompt and reaches idle with the answer in the transcript', async () => {
    const { controller } = build([{ text: 'the answer' }]);
    controller.submit('question');
    await until(controller, (vm) => !controller.isWorking && vm.status === 'idle');

    expect(controller.state.transcript.map((item) => item.kind)).toEqual(['user', 'assistant']);
    expect(controller.state.transcript.at(-1)).toMatchObject({ text: 'the answer' });
  });

  it('/status reports the detail the footer drops, without calling the model', async () => {
    const { controller, client } = build([{ text: 'never' }]);
    controller.submit('/status');
    await until(controller, (vm) => vm.transcript.length > 0);

    const notice = controller.state.transcript.at(-1);
    expect(notice).toMatchObject({ kind: 'notice' });
    const text = (notice as { text: string }).text;
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('workspace');
    expect(text).toContain('cache read');
    expect(text).toContain('ask · writes & commands');
    // Slash commands are client-side; nothing reached the model.
    expect(client.requests).toHaveLength(0);
  });

  it('ignores empty submissions', async () => {
    const { controller, client } = build([{ text: 'never' }]);
    controller.submit('   ');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.requests).toHaveLength(0);
    expect(controller.state.transcript).toEqual([]);
  });

  it('queues follow-ups typed while working and runs them in order', async () => {
    const { controller, client } = build([{ text: 'first' }, { text: 'second' }]);
    controller.submit('one');
    controller.submit('two');
    // The second prompt is visible as queued before it runs.
    expect(controller.state.queued.length).toBeGreaterThanOrEqual(1);

    await until(controller, () => !controller.isWorking && client.requests.length === 2);
    const prompts = controller.state.transcript
      .filter((item) => item.kind === 'user')
      .map((item) => (item.kind === 'user' ? item.text : ''));
    expect(prompts).toEqual(['one', 'two']);
    expect(controller.state.queued).toEqual([]);
  });

  it('notifies subscribers on every update and unsubscribes cleanly', async () => {
    const { controller } = build([{ text: 'ok' }]);
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((vm) => seen.push(vm.status));
    controller.submit('go');
    await until(controller, () => !controller.isWorking);
    expect(seen.length).toBeGreaterThan(1);

    unsubscribe();
    const before = seen.length;
    controller.submit('again');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.length).toBe(before);
  });

  it('routes a permission ask through the responder and records the choice', async () => {
    const { controller } = build(
      [
        { toolCalls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] },
        { text: 'done' }
      ],
      { permissionMode: 'default' }
    );
    controller.submit('write a file');
    await until(controller, (vm) => vm.pendingPermission !== null);
    expect(controller.state.pendingPermission).toMatchObject({ tool: 'write' });

    controller.respondPermission('deny');
    await until(controller, () => !controller.isWorking);
    expect(controller.state.pendingPermission).toBeNull();
    expect(
      controller.state.transcript.some(
        (item) => item.kind === 'notice' && item.text.includes('denied')
      )
    ).toBe(true);
  });

  it('interrupt denies a pending permission rather than hanging', async () => {
    const { controller } = build([
      { toolCalls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] },
      { text: 'after' }
    ]);
    controller.submit('write it');
    await until(controller, (vm) => vm.pendingPermission !== null);

    controller.interrupt();
    await until(controller, () => !controller.isWorking);
    expect(controller.state.pendingPermission).toBeNull();
  });

  it('interrupt stops a running turn and leaves the controller usable', async () => {
    const { controller } = build([{ text: 'a'.repeat(400) }, { text: 'next answer' }]);
    controller.submit('long one');
    controller.interrupt();
    await until(controller, () => !controller.isWorking);

    controller.submit('another');
    const vm = await until(
      controller,
      (state) =>
        !controller.isWorking &&
        state.transcript.some((item) => item.kind === 'assistant' && item.text.includes('next'))
    );
    expect(vm.status).toBe('idle');
  });
});
