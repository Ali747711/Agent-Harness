import type { AgentSession, PermissionChoice } from '@harness/core';

import {
  initialViewModel,
  reduce,
  type ViewModel,
  withNotice,
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
}

export class SessionController {
  private vm: ViewModel;
  private readonly listeners = new Set<(vm: ViewModel) => void>();
  private readonly queue: string[] = [];
  private draining = false;
  private abort: AbortController | null = null;
  private resolvePermission: ((choice: PermissionChoice) => void) | null = null;

  constructor(private readonly options: ControllerOptions) {
    this.vm = initialViewModel(options.model, options.workspaceRoot);
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
    this.queue.push(trimmed);
    this.update(withQueued(this.vm, [...this.queue]));
    void this.drain();
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
          for await (const event of this.options.session.run(prompt, controller.signal)) {
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
