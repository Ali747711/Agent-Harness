# ADR-0002: Runtime — Bun (Node-Portable Core)

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §7, §9](../RESEARCH.md)

## Decision

Bun is the primary supported runtime. All Bun-specific APIs (`Bun.spawn`, `bun:sqlite`, FS helpers) are confined to `packages/core/src/runtime/` so a Node fallback is an adapter swap, not a rewrite. CI runs `tsc --noEmit` under Node 22 as a portability canary.

## Rationale

- CLI startup: ~8–15 ms (Bun) vs ~40–120 ms (Node) — felt on every invocation.
- `bun build --compile` produces a single native binary → distribution without a runtime install (PLAN.md R11).
- Built-in SQLite and process spawning remove dependencies.
- Validated in production by OpenCode (~197k★) on the same workload class; unlocks OpenTUI later if Ink caps out.

## Consequences

- (+) Fast startup, single-binary ship, fewer deps.
- (−) Ecosystem gaps possible (Ink/React, `@vscode/ripgrep` postinstall, test tooling) — mitigated by the step-1 spike (2-hour timebox) and the `runtime/` confinement rule.
- (−) Windows support deferred (Phase 1 targets macOS + Linux).

## Alternatives Considered

- **Node 22+** — broadest compatibility; slower startup, `node:sqlite` still experimental, SEA packaging less mature. Remains the documented fallback via the runtime adapter.
