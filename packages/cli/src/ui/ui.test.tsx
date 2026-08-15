import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentSession, builtinToolRegistry, CONFIG_DEFAULTS, MockModelClient } from '@harness/core';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionController } from '../interactive/controller.ts';
import { initialViewModel, type ViewModel } from '../state/view-model.ts';
import { App } from './app.tsx';
import {
  compactTokens,
  Diff,
  Markdown,
  PermissionDialog,
  StatusBar,
  ToolPanel,
  TranscriptLine
} from './parts.tsx';

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let workspace: string;

beforeEach(async () => {
  // Real directory with real tools: a write must actually reach the
  // permission gate rather than dying as "unknown tool".
  workspace = await mkdtemp(join(tmpdir(), 'harness-ui-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function controllerWith(turns: Parameters<MockModelClient['script']>[0]): SessionController {
  const controller: SessionController = new SessionController({
    session: new AgentSession({
      config: { ...CONFIG_DEFAULTS },
      modelClient: new MockModelClient(turns),
      workspaceRoot: workspace,
      tools: builtinToolRegistry(),
      onPermissionRequest: () => controller.permissionResponder()
    }),
    model: 'claude-opus-5',
    workspaceRoot: workspace
  });
  return controller;
}

function vmWith(patch: Partial<ViewModel>): ViewModel {
  return { ...initialViewModel('claude-opus-5', '/work/repo'), ...patch };
}

describe('compactTokens', () => {
  it('abbreviates thousands so the status bar stays one line', () => {
    expect(compactTokens(0)).toBe('0');
    expect(compactTokens(999)).toBe('999');
    expect(compactTokens(1000)).toBe('1.0k');
    expect(compactTokens(17_927)).toBe('17.9k');
  });
});

describe('markdown and diff rendering', () => {
  it('renders code fences, inline code, bold, and bullets', () => {
    const { lastFrame, unmount } = render(
      createElement(Markdown, {
        source: [
          'Here is **bold** text with `inline code`.',
          '',
          '- first point',
          '- second point',
          '',
          '```ts',
          'const x = 1;',
          '```'
        ].join('\n')
      })
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('bold');
    expect(frame).toContain('inline code');
    expect(frame).toContain('• first point');
    expect(frame).toContain('const x = 1;');
    // The fence markers themselves must not survive into the output.
    expect(frame).not.toContain('```');
    expect(frame).not.toContain('**');
  });

  it('renders a unified diff with hunk headers and +/- lines', () => {
    const { lastFrame, unmount } = render(
      createElement(Diff, {
        text: ['@@ -1,2 +1,3 @@', ' context', '-old line', '+new line'].join('\n')
      })
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('@@ -1,2 +1,3 @@');
    expect(frame).toContain('-old line');
    expect(frame).toContain('+new line');
  });
});

describe('presentational parts', () => {
  it('renders each transcript item kind', () => {
    const cases = [
      { kind: 'user' as const, id: 'u', text: 'my prompt' },
      { kind: 'assistant' as const, id: 'a', text: 'the answer' },
      { kind: 'thinking' as const, id: 't', text: 'pondering' },
      { kind: 'notice' as const, id: 'n', text: 'permission denied' },
      {
        kind: 'error' as const,
        id: 'e',
        severity: 'error',
        code: 'refusal',
        message: 'declined'
      }
    ];
    for (const item of cases) {
      const { lastFrame, unmount } = render(createElement(TranscriptLine, { item }));
      const frame = lastFrame() ?? '';
      unmount();
      expect(frame).toContain(item.kind === 'error' ? 'refusal' : (item as { text: string }).text);
    }
  });

  it('shows tool state, summary, and streamed progress', () => {
    const running = render(
      createElement(ToolPanel, {
        line: {
          callId: 'c1',
          tool: 'bash',
          title: 'run tests',
          status: 'running',
          summary: '',
          durationMs: 0,
          progress: 'PASS one\nPASS two\n',
          startedAt: Date.now()
        }
      })
    );
    expect(running.lastFrame()).toContain('bash');
    expect(running.lastFrame()).toContain('PASS two');
    running.unmount();

    const done = render(
      createElement(ToolPanel, {
        line: {
          callId: 'c1',
          tool: 'read',
          title: 'Read a.ts',
          status: 'ok',
          summary: 'read 2 of 2 lines',
          durationMs: 4,
          progress: '',
          startedAt: Date.now()
        }
      })
    );
    expect(done.lastFrame()).toContain('read 2 of 2 lines');
    done.unmount();
  });

  it('renders the permission dialog with effects, rule, and key hints', () => {
    const { lastFrame, unmount } = render(
      createElement(PermissionDialog, {
        pending: {
          requestId: 'p1',
          tool: 'bash',
          title: 'Run: git status',
          effects: [{ kind: 'execute', command: 'git status' }],
          suggestions: ['bash(git status:*)']
        }
      })
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('permission required');
    expect(frame).toContain('git status');
    expect(frame).toContain('bash(git status:*)');
    expect(frame).toContain('allow once');
  });

  it('status bar surfaces cached and written tokens alongside cost', () => {
    const { lastFrame, unmount } = render(
      createElement(StatusBar, {
        vm: vmWith({
          turn: 2,
          usage: {
            inputTokens: 1500,
            outputTokens: 254,
            cacheReadInputTokens: 17_927,
            cacheCreationInputTokens: 2900,
            costUsd: 0.0638
          },
          queued: ['later']
        })
      })
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('turn 2');
    expect(frame).toContain('17.9k cached');
    expect(frame).toContain('2.9k written');
    expect(frame).toContain('$0.0638');
    expect(frame).toContain('1 queued');
  });
});

describe('App', () => {
  it('renders a completed exchange with the status bar', async () => {
    const controller = controllerWith([{ text: 'hello from the TUI' }]);
    const { lastFrame, unmount } = render(createElement(App, { controller }));
    controller.submit('say hi');
    await settle();
    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('say hi');
    expect(frame).toContain('hello from the TUI');
    expect(frame).toContain('claude-opus-5');
  });

  it('shows the permission dialog and answers it from the keyboard', async () => {
    const controller = controllerWith([
      { toolCalls: [{ name: 'write', input: { path: 'x.txt', content: 'y' } }] },
      { text: 'done' }
    ]);
    const { lastFrame, stdin, unmount } = render(createElement(App, { controller }));
    controller.submit('write a file');
    await settle();
    expect(lastFrame()).toContain('permission required');

    stdin.write('n'); // deny
    await settle();
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).not.toContain('permission required');
    expect(frame).toContain('permission denied');
  });

  it('accepts typed input and clears it on submit', async () => {
    const controller = controllerWith([{ text: 'ok' }]);
    const { lastFrame, stdin, unmount } = render(createElement(App, { controller }));
    stdin.write('hello');
    await settle(50);
    expect(lastFrame()).toContain('hello');

    stdin.write('\r');
    await settle();
    const frame = lastFrame() ?? '';
    unmount();
    // The prompt moved into a 'you' panel rather than staying in the input.
    expect(frame).toContain('you');
    expect(frame).toContain('hello');
  });
});
