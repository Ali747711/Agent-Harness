# SAFETY.md — threat model, stated honestly

> Status: current as of the M2 toolset (read, glob, grep, write, edit, bash) plus the
> opt-in OS sandbox. This document describes what the harness **actually enforces today**.
> Where this file and any other doc differ, this file is the truth.

## The one-paragraph version

The harness confines the **file tools** (read, write, edit, glob, grep) to the workspace root
and gates every write behind a permission decision. The **bash** tool is confined only when
`sandbox.enabled` is on — and it is **off by default**. With the sandbox off, a shell command
runs with the full privileges of the user who started the agent and can read or write anything
that user can, anywhere on the machine; it is gated by *asking you first*, not by a boundary,
so in `default` mode you are the boundary and in `bypass` mode there is effectively none. With
the sandbox on, the kernel enforces the filesystem boundary and **all network egress is denied**
unless you allowlist domains.

## Turning the sandbox on

```bash
harness doctor
```

`doctor` forces the sandbox on and runs real commands through it — an escape write, an
in-workspace write, and a network fetch — then reports what the kernel actually did. Dependency
presence is not confinement; only a blocked escape is. If every probe passes, set:

```json
{ "sandbox": { "enabled": true, "allowedDomains": ["registry.npmjs.org", "github.com"] } }
```

**Read `allowedDomains` carefully.** The sandbox runtime has no "allow everything" setting — an
empty list denies *all* egress from bash, so `npm install`, `git fetch`, and `curl` will fail.
That is a deliberate default, but it is the thing most likely to surprise you.

Two limitations found while building this, stated rather than buried:

- Egress filtering routes through a local proxy. On the development machine this was
  verified to **block** traffic, but allowlisted domains could not be verified as reachable
  (the proxy accepted the CONNECT and then hung upstream, with no violation recorded). Run
  `harness doctor` and try a real `npm install` before depending on an allowlist.
- The sandbox governs **bash only**. The file tools are confined by `WorkspaceGuard`, which is
  a separate mechanism and is always on.

## What is actually enforced

| Property | Enforced by | Applies to |
|---|---|---|
| Path confinement to the workspace root (`..`, absolute paths, symlink escapes, segment-prefix tricks, null bytes all rejected) | `WorkspaceGuard`, canonicalizing via `realpath` before the permission engine sees the request | read · write · edit · glob · grep |
| Writes require an allow decision (rule, session grant, `acceptEdits`, or explicit approval) | `PermissionEngine`, code-enforced, fails closed on error | write · edit |
| Shell commands require an allow decision | `PermissionEngine` (`execute` effects always ask by default) | bash |
| Explicit deny rules win over everything, including `bypass` mode | `PermissionEngine` precedence | all tools |
| No overwrite of a file the model has not read in its current state (mtime + SHA-256) | `FileTracker` + tool-level checks | write · edit |
| Partial writes cannot corrupt a file (temp-then-rename) | `atomicWrite` | write · edit |
| No orphaned child processes on cancel or timeout (process-group SIGTERM → SIGKILL) | `runProcess`, shared by both runners | bash |
| **When `sandbox.enabled`:** writes outside the workspace (+ `$TMPDIR`) are refused by the kernel | `SandboxedCommandRunner` → Seatbelt (macOS) / bubblewrap (Linux) | bash |
| **When `sandbox.enabled`:** reads of `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.config/gh`, `~/.config/gcloud` are denied | same | bash |
| **When `sandbox.enabled`:** network egress is denied except to `sandbox.allowedDomains` | same, via the runtime's proxy | bash |
| An enabled sandbox that cannot initialize refuses to run commands rather than silently running them unconfined | `SandboxedCommandRunner.ready()` fails closed | bash |
| Secret-shaped environment variables (`*API_KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*PRIVATE_KEY*`) are removed from the child environment | `scrubEnv` | bash |
| Tool arguments are passed as argv arrays, never interpolated into a shell string | glob · grep call sites | glob · grep |
| A `tool(prefix:*)` allow rule will not auto-approve a command containing shell control characters (`; && \|\| \| > < \` $() & {} \\` or a newline) — it falls through to `ask` | `safeToAutoApprove` in the permission engine | bash |
| Every run writes an append-only JSONL transcript | `JsonlSessionStore` wired into the headless client | all sessions |

## What is **not** enforced (know this before using `bypass`)

1. **With the sandbox off (the default), bash is not confined to the workspace.** The bash tool
   declares only an `execute` effect — there is no path for the workspace guard to check,
   because a shell command has no single path. `cd /` inside the command is enough to leave;
   so is `cat /etc/hosts`. Pinning the command's initial working directory to the workspace is
   a convenience, not a boundary.

   *Observed in practice:* during the M2 demo, an agent in `bypass` mode was asked to modify
   `/etc/hosts`. It could not write the file — but only because `/etc/hosts` is root-owned and
   the agent process ran as a normal user. It **did** read the file's contents and ownership
   via shell. The OS stopped the write; the harness did not. **This is the case
   `sandbox.enabled` now fixes** — with it on, the same write is refused by the kernel with
   `Operation not permitted`.

2. **With the sandbox off, there is no network restriction.** A command may fetch or exfiltrate
   freely. With it on, egress is denied except to `sandbox.allowedDomains` — see the caveat
   above about verifying an allowlist actually works on your machine.

2b. **Even with the sandbox on, reads are broadly permitted.** Only the listed credential
   directories are denied. A command can still read most of your filesystem; the sandbox's
   write and egress limits are what stop that from becoming damage or exfiltration.

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
- Grant narrow allow rules (`bash(git status:*)`) rather than broad ones (`bash`). A bare `bash`
  rule is a blanket opt-in: unlike prefix rules, it auto-approves chained commands too.
- Keep secrets out of the workspace. Env scrubbing covers the child process environment, not
  files on disk — a `.env` in the workspace is readable by any allowed tool.
- Do not point the agent at a workspace containing content from untrusted sources while running
  in `acceptEdits` or `bypass`.

## What is still outstanding

`@anthropic-ai/sandbox-runtime` now drops in behind the `CommandRunner` seam
(`packages/core/src/exec/runner.ts`) as `SandboxedCommandRunner`, so items 1–2 above are
enforced rather than advisory **when it is enabled**. Still to come: making it the default
once allowlisted egress is verified on more machines, checkpoints/rewind, and the
catastrophic-command denylist.

## Reporting

This is pre-release software under active construction. Defects worth reporting:

- escaping the workspace using a **path-declaring tool** (read/write/edit/glob/grep);
- writing outside the workspace from bash **while `sandbox.enabled` is on**;
- any case where an enabled sandbox silently runs a command unconfined instead of refusing.

Bash reaching outside the workspace with the sandbox **off** is expected behavior, documented
above.
