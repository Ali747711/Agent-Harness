import {
  type AgentSession,
  type Effort,
  EffortSchema,
  type PermissionChoice,
  type PermissionMode,
  PermissionModeSchema
} from '@harness/core';

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
// Pure formatting/label modules — no React or Ink crosses this boundary.
import { tildePath } from '../ui/format.ts';
import { MODE_DISPLAY } from '../ui/theme.ts';

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
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PERMISSION_MODES = ['default', 'acceptEdits', 'bypass'] as const;
const MODEL_SUGGESTIONS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

/** What /config save persists. Writing files stays out of the controller. */
export interface SavedSettings {
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
}

export interface ControllerOptions {
  session: AgentSession;
  model: string;
  workspaceRoot: string;
  /** Shown by /status; the header takes its own copy. */
  version?: string;
  permissionMode?: PermissionMode;
  /** Shown in the header, before session_started has fired. */
  memoryFiles?: readonly string[];
  /** Sandbox state for the header and /status. */
  sandbox?: { enabled: boolean; allowedDomains: readonly string[] };
  gitBranch?: string | null;
  /** Used by /clear to start a fresh conversation (and a fresh transcript). */
  newSession?: () => Promise<AgentSession> | AgentSession;
  /** Backs /sessions; injected so the controller stays free of storage concerns. */
  listSessions?: () => Promise<string[]>;
  /** Shown by /permissions; the engine owns enforcement, this is display only. */
  permissions?: { allow: readonly string[]; deny: readonly string[] };
  /** Backs /config save. Returns the path written, for the confirmation. */
  saveSettings?: (settings: SavedSettings) => Promise<string>;
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
      gitBranch: options.gitBranch ?? null,
      sandbox: {
        enabled: options.sandbox?.enabled ?? false,
        allowedDomains: [...(options.sandbox?.allowedDomains ?? [])]
      }
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
      void this.runCommand(command.name, command.args);
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

  private async runCommand(name: string, args = ''): Promise<void> {
    switch (name) {
      case 'help': {
        const lines = SLASH_COMMANDS.map(
          (command) => `/${command.name.padEnd(9)} ${command.summary}`
        ).join('\n');
        // Two short hint lines rather than one long one: a single line wraps
        // mid-binding on an 80-column terminal.
        this.update(
          withNotice(
            this.vm,
            [
              lines,
              '',
              'enter submit · shift+enter newline · ↑/↓ history',
              'esc interrupt · ctrl-w delete word · shift+tab permission mode · ctrl-c quit'
            ].join('\n')
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
      // Settings are changed from inside the session, not by restarting with
      // different flags — the point is to dial cost down mid-task.
      case 'model': {
        const current = this.session.modelSettings;
        if (args === '') {
          this.update(
            withNotice(
              this.vm,
              `model: ${current.model}\nusage: /model <id>   e.g. ${MODEL_SUGGESTIONS.join(' · ')}`
            )
          );
          return;
        }
        this.session.setModelSettings({ model: args });
        // Caches are per-model, so the next request necessarily re-writes the
        // prefix. Saying so keeps the one-off cost spike explicable.
        this.update({
          ...withNotice(this.vm, `model → ${args} (the next request rebuilds the prompt cache)`),
          model: args
        });
        return;
      }
      case 'effort': {
        const current = this.session.modelSettings;
        if (args === '') {
          this.update(
            withNotice(
              this.vm,
              `effort: ${current.effort}\nusage: /effort <${EFFORT_LEVELS.join('|')}>\n` +
                'lower effort means less thinking per turn — the biggest single lever on cost'
            )
          );
          return;
        }
        const parsed = EffortSchema.safeParse(args);
        if (!parsed.success) {
          this.update(
            withNotice(this.vm, `unknown effort "${args}" — use ${EFFORT_LEVELS.join(', ')}`)
          );
          return;
        }
        this.session.setModelSettings({ effort: parsed.data });
        // Effort is a request parameter, not prefix material, so this costs
        // nothing in cache terms (ADR-0008).
        this.update(withNotice(this.vm, `effort → ${parsed.data} (cache unaffected)`));
        return;
      }
      case 'permissions': {
        if (args !== '') {
          const parsed = PermissionModeSchema.safeParse(args);
          if (!parsed.success) {
            this.update(
              withNotice(this.vm, `unknown mode "${args}" — use ${PERMISSION_MODES.join(', ')}`)
            );
            return;
          }
          this.session.setPermissionMode(parsed.data);
          this.update(withPermissionMode(this.vm, parsed.data));
        }
        const mode = MODE_DISPLAY[this.vm.permissionMode];
        const rules = this.options.permissions ?? { allow: [], deny: [] };
        this.update(
          withNotice(
            this.vm,
            [
              `mode   ${mode.label} · ${mode.detail}   (shift+tab cycles)`,
              `allow  ${rules.allow.length === 0 ? 'none' : rules.allow.join(', ')}`,
              `deny   ${rules.deny.length === 0 ? 'none' : rules.deny.join(', ')}`,
              `usage: /permissions <${PERMISSION_MODES.join('|')}>`,
              'rules live in config; deny always wins, even in bypass'
            ].join('\n')
          )
        );
        return;
      }
      case 'config': {
        if (args !== 'save') {
          this.update(
            withNotice(
              this.vm,
              'usage: /config save — persist model, effort, and permission mode to this project'
            )
          );
          return;
        }
        if (this.options.saveSettings === undefined) {
          this.update(withNotice(this.vm, '/config save is unavailable in this mode'));
          return;
        }
        const current = this.session.modelSettings;
        try {
          const path = await this.options.saveSettings({
            model: current.model,
            effort: current.effort,
            permissionMode: this.vm.permissionMode
          });
          this.update(withNotice(this.vm, `saved to ${path}`));
        } catch (error) {
          this.update(
            withNotice(
              this.vm,
              `could not save: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        }
        return;
      }
      // The footer sheds detail to stay on one line; this is where it lands.
      case 'status': {
        const totals = this.session.usage();
        const mode = MODE_DISPLAY[this.vm.permissionMode];
        const branch = this.vm.gitBranch === null ? '' : ` ⎇ ${this.vm.gitBranch}`;
        this.update(
          withNotice(
            this.vm,
            [
              `harness v${this.options.version ?? '0.0.1'} · ${this.options.model}`,
              `workspace  ${tildePath(this.options.workspaceRoot)}${branch}`,
              `memory     ${this.vm.memoryFiles.length === 0 ? 'none' : this.vm.memoryFiles.join(', ')}`,
              `mode       ${mode.label} · ${mode.detail}`,
              `sandbox    ${
                this.vm.sandbox.enabled
                  ? `on · egress: ${
                      this.vm.sandbox.allowedDomains.length === 0
                        ? 'all denied'
                        : this.vm.sandbox.allowedDomains.join(', ')
                    }`
                  : 'off — bash is not confined (see SAFETY.md)'
              }`,
              `session    ${this.vm.sessionId ?? 'not started'} · turn ${this.vm.turn}`,
              `context    ${this.vm.contextTokens} tokens in the last request`,
              `usage      ${totals.inputTokens} in · ${totals.outputTokens} out · ` +
                `${totals.cacheReadInputTokens} cache read · ${totals.cacheCreationInputTokens} cache write · ` +
                `$${totals.costUsd.toFixed(4)}`
            ].join('\n')
          )
        );
        return;
      }
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
