# ADR-0004: Sessions — Append-Only JSONL Source of Truth + SQLite Derived Index

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §7](../RESEARCH.md) — Claude Code JSONL transcripts; pi's `id`/`parentId` tree; OpenCode's SQLite persistence.

## Decision

Every session is an append-only JSONL transcript — the sole source of truth. Entries carry `{ id, parentId, ts, type, agentId, ... }`; the `parentId` tree enables in-place branching and rewind later without a format migration. SQLite (`bun:sqlite`) holds a **derived** index for listing/resume metadata and is always rebuildable from JSONL (`reindex`).

Storage: `~/.harness/projects/<slug>-<hash>/<sessionId>.jsonl`; index at `~/.harness/index.db` (out-of-repo so transcripts are never accidentally committed). Durability: fsync at turn boundaries; readers tolerate a truncated trailing line.

## Rationale

- Append-only JSONL is auditable, crash-tolerant, resumable, and diff-able; it doubles as the record/replay format for golden tests.
- The tree structure is ~20 lines now and buys branching, rewind (Esc-Esc-style), and subagent scoping (ADR-0005) later.
- SQLite gives fast `sessions list` without making the DB authoritative.

## Consequences

- (+) Kill -9 at any point leaves a resumable session.
- (+) Golden-transcript regression suite comes nearly free.
- (−) Two storage layers to keep consistent — mitigated by the "delete DB, reindex, assert equality" test.

## Alternatives Considered

- **SQLite as source of truth** — better queries, worse auditability/portability; rejected.
- **Flat JSONL without parentId** — simpler now, forces a migration for branching/rewind/subagents; rejected.
