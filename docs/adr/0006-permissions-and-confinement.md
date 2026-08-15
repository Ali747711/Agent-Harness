# ADR-0006: Permissions — Code-Enforced Engine + Non-Overridable Workspace Confinement

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §8](../RESEARCH.md); PLAN.md §8 "harness over prompt".

## Decision

A pure, code-enforced `PermissionEngine` decides allow/ask/deny per tool call. Structure:

- **Tools split `plan()` (pure effect declaration) from `execute()` (receives only canonicalized, pre-approved handles)** — enforcement is structural, not advisory; re-canonicalize at execute time to close TOCTOU.
- **WorkspaceGuard is a separate, non-bypassable pre-check**: realpath canonicalization, segment-boundary comparison, symlink-escape rejection. No rule can approve a path outside the workspace root in Phase 1.
- Precedence: guard → deny rules → session grants → allow rules → mode default → ask. Evaluation errors fail **closed**.
- Modes: `default` (read-only auto; writes/shell ask), `acceptEdits`, `bypass` (explicit scary flag + banner).
- Bash policy stated honestly: no shell-parse "safe subset" (false confidence); ask-by-default with full command shown, prefix-match allowlist rules, catastrophic-pattern denylist as backstop only. The real boundary is the Phase-2 OS sandbox (`@anthropic-ai/sandbox-runtime` — Seatbelt/bubblewrap + network proxy filtering) behind the `CommandRunner` seam designed now.

## Consequences

- (+) A config typo cannot become an arbitrary-write bug; the engine is pure and table-testable.
- (+) srt lands in Phase 2 as a one-implementation swap.
- (−) MVP safety honestly depends on human-in-the-loop for bash — documented in `SAFETY.md`.

## Phase 2 amendment (2026-08-16): the sandbox landed, opt-in

The `CommandRunner` seam held: `SandboxedCommandRunner` (`core/src/exec/sandbox.ts`) wraps each
command via `wrapWithSandboxArgv` and reuses the same `runProcess` machinery, so process-group
kill, timeouts, and output caps are shared rather than reimplemented. Verified on macOS 15.7:
a write outside the workspace is refused by the kernel; one inside succeeds.

Three decisions worth recording:

1. **It fails closed, never soft.** If the platform cannot sandbox or a dependency is missing,
   an enabled sandbox refuses to run the command. Silently falling back to an unconfined shell
   would leave a user believing they were protected — strictly worse than knowing they are not.
2. **Default off.** The runtime has no "allow all" network setting, so enabling the sandbox also
   denies all egress. Shipping that as the default would break `npm install` on first use and
   get the sandbox switched off permanently. A `harness doctor` command runs real escape probes
   so a user can verify and opt in. The default flips once allowlisted egress is verified on
   more machines — see the caveat in `SAFETY.md`.
3. **Read denials cover credential stores outside the workspace only.** Denying in-workspace
   secrets (`**/.env`) would make `cat .env` fail while the `read` tool still succeeded, since
   the sandbox governs bash and `WorkspaceGuard` governs the file tools — two different answers
   to "is this readable?".

The runtime is imported lazily (boundary rule 4 confines it to `core/src/exec/`), matching the
`@vscode/ripgrep` lesson: packages with vendored binaries can throw at import time inside
`bun build --compile`.

## Alternatives Considered

- **Prompt-level safety** — rejected outright (PLAN.md principle 1).
- **Shell AST parsing for auto-approval** — rejected for MVP; produces false confidence.
- **Container-only sandboxing** — heavier UX than srt's OS primitives; remains an opt-in escape hatch.
