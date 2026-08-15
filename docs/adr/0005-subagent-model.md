# ADR-0005: Subagents — In-Process, One Level Deep, Restricted Tools, Flat History

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §3, §9](../RESEARCH.md) — MinusX finding: Claude Code runs one main thread, max one branch; subagents cannot spawn subagents; results return as tool_results in the flat main history.

## Decision

Subagents (Phase 3 feature) run **in-process**, with **exactly one nesting level**, a **restricted toolset** (no Task tool), and return a summary as a `tool_result` in the flat main history. Phase 1 pays only the session-format reservation: every `SessionEntry` carries `agentId`/`parentAgentId`, and `resolvePath` filters by agent scope from day one (a no-op while only the root agent exists).

## Rationale

- Debuggability beats orchestration cleverness — the pattern every production harness converged on.
- Deciding this before Phase 1 is mandatory because the session store must represent it; retrofitting costs a transcript migration (~20 lines now vs a breaking change later).
- Worktree/subprocess isolation for parallel writes is deferred to Phase 4 and slots in behind the same entry scoping.

## Consequences

- (+) No cascade complexity; flat history stays the single debugging artifact.
- (+) Context isolation for heavy work without multi-agent framework risk.
- (−) No parallel multi-agent orchestration in the core (deliberate non-goal per PLAN.md).

## Alternatives Considered

- **Subprocess subagents** — stronger isolation, expensive IPC/state plumbing; deferred.
- **Arbitrary-depth agent trees** — rejected; every credible analysis flags this as a debuggability trap.
