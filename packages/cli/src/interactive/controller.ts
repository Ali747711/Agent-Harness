import type { AgentSession, PermissionChoice, PermissionMode } from '@harness/core';

import { isKnownCommand, parseSlash, SLASH_COMMANDS } from '../state/slash.ts';
import {
  initialViewModel,
  reduce,
  type ViewModel,
  withNotice,
  withPermissionMode,
  withQueued,
  withUserPrompt
} from '../state/view-model.ts';

/**
 * Owns the session lifecycle outside React (step 13). The Ink layer only
 * renders a ViewModel and calls these methods, which keeps every interesting
 * behavior — queuing, interrupt, permission round-trip — testable with no
 * terminal involved.
 *
 * Follow-ups typed while the agent is working are QUEUED and submitted when it
 * goes idle. True mid-turn steering (injecting into a running turn) needs loop
 * support and is deferred; the protocol's `steer` command is reserved for it.
 */
export interface ControllerOptions {
  session: AgentSession;
  model: string;
  workspaceRoot: string;
  permissionMode?: PermissionMode;
  /** Shown in the header, before session_started has fired. */
  memoryFiles?: readonly string[];
  gitBranch?: string | null;
  /** Used by /clear to start a fresh conversation (and a fresh transcript). */
  newSession?: () => Promise<AgentSession> | AgentSession;
  /** Backs /sessions; injected so the controller stays free of storage concerns. */
  listSessions?: () => Promise<string[]>;
}

export class SessionController {
  private session: AgentSession;
  private vm: ViewModel;
  private readonly listeners = new Set<(vm: ViewModel) => void>();
  private readonly queue: string[] = [];
  private draining = false;
  private abort: AbortController | null = null;
  private resolvePermission: ((choice: PermissionChoice) => void) | null = null;

  constructor(private readonly options: ControllerOptions) {
    this.session = options.session;
    this.vm = {
      ...withPermissionMode(
        initialViewModel(options.model, options.workspaceRoot),
        options.permissionMode ?? 'default'
      ),
      memoryFiles: [...(options.memoryFiles ?? [])],
      gitBranch: options.gitBranch ?? null
    };
  }

  /** shift+tab: default → acceptEdits → bypass → default. */
  cyclePermissionMode(): void {
    const order: PermissionMode[] = ['default', 'acceptEdits', 'bypass'];
    const next = order[(order.indexOf(this.vm.permissionMode) + 1) % order.length] ?? 'default';
    this.session.setPermissionMode(next);
    this.update(withPermissionMode(this.vm, next));
  }

  get state(): ViewModel {
    return this.vm;
  }

  get isWorking(): boolean {
    return this.draining;
  }

  subscribe(listener: (vm: ViewModel) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The approver handed to AgentSession; resolved by respondPermission(). */
  permissionResponder = (): Promise<PermissionChoice> =>
    new Promise<PermissionChoice>((resolve) => {
      this.resolvePermission = resolve;
    });

  respondPermission(choice: PermissionChoice): void {
    const resolve = this.resolvePermission;
    this.resolvePermission = null;
    resolve?.(choice);
  }

  submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    // Slash commands are client-side: they never reach the model.
    const command = parseSlash(trimmed);
    if (command !== null && isKnownCommand(command.name)) {
      void this.runCommand(command.name);
      return;
    }
    if (command !== null) {
      this.update(withNotice(this.vm, `unknown command /${command.name} — try /help`));
      return;
    }
    this.queue.push(trimmed);
    this.update(withQueued(this.vm, [...this.queue]));
    void this.drain();
  }

  private async runCommand(name: string): Promise<void> {
    switch (name) {
      case 'help': {
        const lines = SLASH_COMMANDS.map(
          (command) => `/${command.name.padEnd(9)} ${command.summary}`
        ).join('\n');
        this.update(
          withNotice(
            this.vm,
            `${lines}\n\nenter submit · shift+enter newline · ↑/↓ history · ctrl-w delete word · esc interrupt · ctrl-c quit`
          )
        );
        return;
      }
      case 'cost': {
        const totals = this.session.usage();
        this.update(
          withNotice(
            this.vm,
            `${totals.requests} request(s) · ${totals.inputTokens} in · ${totals.outputTokens} out · ` +
              `${totals.cacheReadInputTokens} cache read · ${totals.cacheCreationInputTokens} cache write · ` +
              `$${totals.costUsd.toFixed(4)} · cache hit ${(totals.cacheHitRatio * 100).toFixed(0)}%`
          )
        );
        return;
      }
      case 'model':
        this.update(withNotice(this.vm, `model: ${this.options.model}`));
        return;
      case 'sessions': {
        const list = (await this.options.listSessions?.()) ?? [];
        this.update(
          withNotice(this.vm, list.length === 0 ? 'no other sessions yet' : list.join('\n'))
        );
        return;
      }
      case 'clear': {
        if (this.options.newSession === undefined) {
          this.update(withNotice(this.vm, '/clear is unavailable in this mode'));
          return;
        }
        if (this.draining) {
          this.update(withNotice(this.vm, 'finish or interrupt the current turn before /clear'));
          return;
        }
        this.session = await this.options.newSession();
        // A fresh view AND a fresh conversation: the point of /clear is that
        // the next turn carries no prior context.
        const mode = this.vm.permissionMode;
        this.vm = withPermissionMode(
          initialViewModel(this.options.model, this.options.workspaceRoot),
          mode
        );
        this.session.setPermissionMode(mode);
        this.update(withNotice(this.vm, 'cleared — new session started'));
        return;
      }
      default:
        this.update(withNotice(this.vm, `/${name} is not implemented yet`));
    }
  }

  /** Cancel the running turn; a pending permission ask resolves as deny. */
  interrupt(): void {
    if (this.resolvePermission !== null) {
      this.respondPermission('deny');
    }
    this.abort?.abort();
  }

  private update(next: ViewModel): void {
    this.vm = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const prompt = this.queue.shift() as string;
        this.update(withQueued(withUserPrompt(this.vm, prompt), [...this.queue]));

        const controller = new AbortController();
        this.abort = controller;
        try {
          for await (const event of this.session.run(prompt, controller.signal)) {
            this.update(reduce(this.vm, event));
          }
          if (controller.signal.aborted) {
            this.update(withNotice(this.vm, 'interrupted'));
          }
        } catch (error) {
          this.update(
            withNotice(
              this.vm,
              `session error: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        } finally {
          this.abort = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
