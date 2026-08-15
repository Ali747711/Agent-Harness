# SAFETY.md — Phase-1 threat model, stated honestly

> Status: current as of the M2 toolset (read, glob, grep, write, edit, bash).
> This document describes what the harness **actually enforces today**, not what it will
> enforce once the Phase-2 OS sandbox lands. Where the two differ, this file is the truth.

## The one-paragraph version

The harness confines the **file tools** (read, write, edit, glob, grep) to the workspace root
and gates every write behind a permission decision. It does **not** confine the **bash** tool:
a shell command runs with the full privileges of the user who started the agent, and can read
or write anything that user can, anywhere on the machine. Bash is gated by *asking you first*,
not by a boundary — so in `default` mode you are the boundary, and in `bypass` mode there is
effectively none. The real confinement layer (OS-level sandboxing) is Phase 2.

## What is actually enforced

| Property | Enforced by | Applies to |
|---|---|---|
| Path confinement to the workspace root (`..`, absolute paths, symlink escapes, segment-prefix tricks, null bytes all rejected) | `WorkspaceGuard`, canonicalizing via `realpath` before the permission engine sees the request | read · write · edit · glob · grep |
| Writes require an allow decision (rule, session grant, `acceptEdits`, or explicit approval) | `PermissionEngine`, code-enforced, fails closed on error | write · edit |
| Shell commands require an allow decision | `PermissionEngine` (`execute` effects always ask by default) | bash |
| Explicit deny rules win over everything, including `bypass` mode | `PermissionEngine` precedence | all tools |
| No overwrite of a file the model has not read in its current state (mtime + SHA-256) | `FileTracker` + tool-level checks | write · edit |
| Partial writes cannot corrupt a file (temp-then-rename) | `atomicWrite` | write · edit |
| No orphaned child processes on cancel or timeout (process-group SIGTERM → SIGKILL) | `DirectCommandRunner` | bash |
| Secret-shaped environment variables (`*API_KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*PRIVATE_KEY*`) are removed from the child environment | `scrubEnv` | bash |
| Tool arguments are passed as argv arrays, never interpolated into a shell string | glob · grep call sites | glob · grep |

## What is **not** enforced (know this before using `bypass`)

1. **Bash is not confined to the workspace.** The bash tool declares only an `execute` effect —
   there is no path for the workspace guard to check, because a shell command has no single
   path. `cd /` inside the command is enough to leave; so is `cat /etc/hosts`. Pinning the
   command's initial working directory to the workspace is a convenience, not a boundary.

   *Observed in practice:* during the M2 demo, an agent in `bypass` mode was asked to modify
   `/etc/hosts`. It could not write the file — but only because `/etc/hosts` is root-owned and
   the agent process ran as a normal user. It **did** read the file's contents and ownership
   via shell. The OS stopped the write; the harness did not.

2. **No network restriction.** A command may fetch or exfiltrate over the network. There is no
   egress policy in Phase 1.

3. **No protection against a command the user approved.** Approval is per-effect, not per-
   consequence. Approving `bash(npm:*)` approves whatever the package's lifecycle scripts do.

4. **Rules are tool-scoped.** `deny: ["write(secrets/**)"]` stops the *write tool* only. Denying
   a path across every writer needs one rule per write-capable tool (`write`, `edit`, `bash`),
   and even then bash can be denied only by command pattern, not by path.

5. **The catastrophic-command denylist described in ADR-0006 is not implemented yet**, and when
   it lands it will be a typo-catcher, not a security control.

6. **Tool output is untrusted input.** File contents, command output, and search results are
   data, not instructions. The harness does not currently detect or neutralize prompt-injection
   payloads embedded in files the agent reads.

## Permission modes

| Mode | Reads | Writes | Shell | When it is appropriate |
|---|---|---|---|---|
| `default` | auto | ask | ask | Normal use. You are the boundary for every mutation. |
| `acceptEdits` | auto | auto (workspace-confined) | ask | Focused editing in a repo you can restore from git. |
| `bypass` | auto | auto | **auto** | Only inside a container/VM you are willing to lose, or for a command set you have fully reviewed. Explicit deny rules still apply. |

In headless mode (`-p`) there is no interactive approver: anything that would ask is **denied**,
with the suggested allow rule printed in the tool result. That is the intended fail-closed
behavior, not a bug.

## Recommended posture

- Run in a **git repository with a clean working tree** so any change is `git diff`-able and
  revertable. The harness has no checkpoint/undo of its own yet (Phase 2).
- Prefer `default`; reach for `acceptEdits` when iterating; treat `bypass` as "I am in a
  disposable environment".
- Grant narrow allow rules (`bash(git status:*)`) rather than broad ones (`bash`).
- Keep secrets out of the workspace. Env scrubbing covers the child process environment, not
  files on disk — a `.env` in the workspace is readable by any allowed tool.
- Do not point the agent at a workspace containing content from untrusted sources while running
  in `acceptEdits` or `bypass`.

## What Phase 2 changes

`@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux, plus proxy-based
network filtering) drops in behind the existing `CommandRunner` seam
(`packages/core/src/exec/runner.ts`). At that point bash gains a real filesystem and network
boundary, and items 1–2 above become enforced rather than advisory. Checkpoints/rewind and the
command denylist land in the same phase.

## Reporting

This is pre-release software under active construction. If you find a way to escape the
workspace using a **path-declaring tool** (read/write/edit/glob/grep), that is a defect —
please report it. Bash reaching outside the workspace is currently expected behavior, documented
above.
