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

## Alternatives Considered

- **Prompt-level safety** — rejected outright (PLAN.md principle 1).
- **Shell AST parsing for auto-approval** — rejected for MVP; produces false confidence.
- **Container-only sandboxing** — heavier UX than srt's OS primitives; remains an opt-in escape hatch.
