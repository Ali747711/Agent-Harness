# ADR-0009: Project Memory — Configurable Ordered Load List

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §9](../RESEARCH.md); PLAN.md §11 open decision (`CLAUDE.md` vs `AGENTS.md` vs both).

## Decision

Project memory is a **configurable, ordered filename list**, loaded hierarchically from the workspace root at session start into the frozen system prompt (with per-file and total size caps). Default order: `<product>.md` (name TBD — pre-step-1 decision) → `AGENTS.md` → `CLAUDE.md`. Later entries do not override earlier ones; all matched files load in order.

## Rationale

- Compatibility is nearly free (a load-path list) and removes adoption friction: teams with existing `CLAUDE.md`/`AGENTS.md` conventions get behavior on day one.
- `AGENTS.md` is the emerging cross-vendor convention (Codex et al.); `CLAUDE.md` is the largest installed base.
- Loading at session start keeps the system prompt frozen (ADR-0008); mid-session memory reloads are injected late in messages, not into the prefix.

## Consequences

- (+) Zero-config behavior change is demonstrable (a Phase-1 acceptance test).
- (−) Multiple memory files can conflict; conflict resolution is "concatenate in order, document it" for MVP.

## Alternatives Considered

- **Single proprietary filename only** — cleaner, hostile to adoption; rejected.
- **Auto-merging/deduplicating memory** — speculative complexity; deferred.
