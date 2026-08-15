# ADR-0008: Context Pipeline & Prompt-Cache Discipline

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §5](../RESEARCH.md) — prompt caching is prefix-matched (tools → system → messages); cache reads ~0.1× input price; 20-content-block lookback; mid-conversation `role:"system"` messages are cache-safe on current Opus-class models.

## Decision

`ContextPipeline` is a strategy interface from day one; Phase 1 ships `PassthroughPipeline` (no compaction). Non-negotiable cache rules, each backed by a test:

1. **System prompt is frozen per session** — environment facts (cwd, OS, date, git branch) snapshotted once at session start; byte-identical prefix across turns (byte-equality test).
2. Tool specs sorted by name, canonically serialized.
3. Breakpoints at stable-prefix boundary + rolling near the message tail; intermediate breakpoint for long tool-heavy turns (20-block lookback).
4. **Dynamic context is injected late in `messages`** — via mid-conversation `{role:"system"}` messages where the model supports it (capability-flagged), else `<system-reminder>` text in a user turn.
5. Token/cost accounting from API `usage` fields only — **never tiktoken** (undercounts Claude 15–20%+).
6. History is append-only and immutable in memory.

Phase 2 swaps in compaction as a strategy: client-side summarization (provider-agnostic, full control) and server-side compaction (beta `compact_20260112`) are both drop-ins.

## Consequences

- (+) The product's economics: turn-2+ cache hits are asserted in CI (`cache_read_input_tokens > 0`).
- (+) Compaction lands without loop surgery.
- (−) Discipline cost: any PR touching `context/` must keep the byte-equality test green.

## Alternatives Considered

- **Re-render system prompt per turn** (fresh git state) — silently destroys the cache; the freshness goes into late-message injection instead.
- **Client-side token estimation** — wrong tokenizer, drifting budgets; rejected.
