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

  const sessionOptions = {
    config: options.config,
    modelClient,
    workspaceRoot: options.workspaceRoot,
    tools: builtinToolRegistry(),
    memory,
    environment
  };

  // /clear starts a genuinely fresh conversation AND a fresh transcript, so
  // the old one stays intact and resumable.
  let active = opened;
  const controller = new SessionController({
    session: AgentSession.fromEntries(opened.entries, {
      ...sessionOptions,
      sink: opened.sink,
      onPermissionRequest: () => controller.permissionResponder()
    }),
    model: options.config.model,
    workspaceRoot: options.workspaceRoot,
    newSession: async () => {
      await active.sink.close().catch(() => undefined);
      active = await store.create({
        workspaceRoot: options.workspaceRoot,
        model: options.config.model
      });
      return AgentSession.fromEntries(active.entries, {
        ...sessionOptions,
        sink: active.sink,
        onPermissionRequest: () => controller.permissionResponder()
      });
    },
    listSessions: async () => {
      const index = await SessionIndex.open(options.indexPath ?? indexDbPath());
      try {
        await index.reindex(sessionsDir);
        return index
          .list(options.workspaceRoot, 10)
          .map((session) => `${session.sessionId.slice(0, 8)}  ${session.title}`);
      } finally {
        index.close();
      }
    }
  });

  const instance = render(createElement(App, { controller }));
  try {
    await instance.waitUntilExit();
  } finally {
    await active.sink.close().catch(() => undefined);
    // Refresh the derived index so --continue finds this session (ADR-0004).
    try {
      const index = await SessionIndex.open(options.indexPath ?? indexDbPath());
      await index.refresh(active.filePath);
      index.close();
    } catch {
      // The index is derived; failing to update it must never fail the session.
    }
  }
  return 0;
}
