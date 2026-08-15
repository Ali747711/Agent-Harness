import {
  AgentSession,
  builtinToolRegistry,
  type Config,
  createAnthropicModelClient,
  indexDbPath,
  JsonlSessionStore,
  loadProjectMemory,
  type ModelClient,
  type OpenedSession,
  probeEnvironment,
  projectSessionsDir,
  SessionIndex
} from '@harness/core';
import { render } from 'ink';
import { createElement } from 'react';

import { App } from '../ui/app.tsx';
import { SessionController } from './controller.ts';

export interface InteractiveOptions {
  config: Config;
  workspaceRoot: string;
  /** Resume this session id; otherwise a fresh one is created. */
  resumeSessionId?: string;
  transcriptDir?: string;
  indexPath?: string;
}

export interface InteractiveDeps {
  modelClient?: ModelClient;
}

/** Runs the interactive TUI until the user exits. Returns the exit code. */
export async function runInteractive(
  options: InteractiveOptions,
  deps: InteractiveDeps = {}
): Promise<number> {
  const modelClient = deps.modelClient ?? createAnthropicModelClient();
  const sessionsDir = options.transcriptDir ?? projectSessionsDir(options.workspaceRoot);
  const store = new JsonlSessionStore(sessionsDir);

  let opened: OpenedSession;
  try {
    opened =
      options.resumeSessionId === undefined
        ? await store.create({
            workspaceRoot: options.workspaceRoot,
            model: options.config.model
          })
        : await store.open(options.resumeSessionId);
  } catch (error) {
    process.stderr.write(`cannot open session transcript: ${String(error)}\n`);
    return 1;
  }

  const [memory, environment] = await Promise.all([
    loadProjectMemory({
      workspaceRoot: options.workspaceRoot,
      filenames: options.config.memoryFiles
    }),
    probeEnvironment(options.workspaceRoot)
  ]);

  const controller = new SessionController({
    session: AgentSession.fromEntries(opened.entries, {
      config: options.config,
      modelClient,
      workspaceRoot: options.workspaceRoot,
      tools: builtinToolRegistry(),
      sink: opened.sink,
      memory,
      environment,
      onPermissionRequest: () => controller.permissionResponder()
    }),
    model: options.config.model,
    workspaceRoot: options.workspaceRoot
  });

  const instance = render(createElement(App, { controller }));
  try {
    await instance.waitUntilExit();
  } finally {
    await opened.sink.close().catch(() => undefined);
    // Refresh the derived index so --continue finds this session (ADR-0004).
    try {
      const index = await SessionIndex.open(options.indexPath ?? indexDbPath());
      await index.refresh(opened.filePath);
      index.close();
    } catch {
      // The index is derived; failing to update it must never fail the session.
    }
  }
  return 0;
}
