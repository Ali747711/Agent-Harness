# ADR-0007: MVP Toolset & Schema Discipline

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §3, §7](../RESEARCH.md) — mixed tool granularity is deliberate; tool descriptions are product surface (~9k tokens of fixed spend in Claude Code); agentic ripgrep search, never RAG.

## Decision

Phase 1 ships exactly six tools: **Read, Write, Edit (exact string-replace), Glob, Grep (vendored ripgrep via `@vscode/ripgrep`, argv-only, no shell interpolation), Bash**. Discipline:

- Schemas in **Zod 4**; wire specs via `z.toJSONSchema()` with `strict: true` + `additionalProperties: false`; Zod re-validation on receipt (defense in depth).
- Deterministic tool ordering and canonical serialization (cache stability, ADR-0008).
- Every tool declares `readOnly` (drives permissions now, parallel scheduling later), has an output budget with explicit truncation markers, and returns failures as structured `tool_result` errors — never thrown into the loop.
- Edit enforces a **read-before-write invariant** (mtime+hash tracked per session) and unique-match semantics.
- No RAG/embeddings for code search — agentic search only.

## Consequences

- (+) Reliable tool calls (schema-guaranteed input), gateable/renderable/auditable effects.
- (+) Descriptions treated as designed product surface with a token budget.
- (−) WebSearch/WebFetch deferred until a network egress policy exists (Phase 2, with sandbox).

## Alternatives Considered

- **Bash-only minimalism** (pi's four tools) — elegant, but dedicated tools give the harness typed hooks to gate and parallelize; frequency of use justifies Read/Edit/Grep/Glob promotion.
- **Patch/udiff edit format** — Aider's data shows format choice moves success rates; exact string-replace matches Claude's training (Claude Code semantics), and the format is swappable + eval-able later.
