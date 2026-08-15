# ADR-0010: Model Configuration = (model, effort, thinking) — No Sampling Params, Streaming Always

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §5](../RESEARCH.md) — current Claude models (Opus 5-class) reject `temperature`/`top_p`/`top_k` (400) and removed `budget_tokens`; depth is controlled by `output_config.effort` (`low…xhigh…max`) with adaptive thinking.

## Decision

The internal model configuration is exactly `(model, effort, thinkingMode)` plus `maxTokens`. Sampling parameters are **not representable in `ModelRequest`** — passing one is a config validation error, not a silently-dropped field. Streaming is always on. The loop exhaustively switches `stop_reason` (`end_turn | tool_use | max_tokens | stop_sequence | refusal | pause_turn`) with a TypeScript `never` check.

Defaults: `claude-opus-5`, effort `xhigh` (the documented sweet spot for coding/agentic work), adaptive thinking. `ModelClient` exposes a `capabilities` object (systemRoleMessages, adaptiveThinking, effortLevels, maxCacheBreakpoints) so provider differences branch on capability flags, not provider names.

## Rationale

- Encoding the current API surface in types prevents an entire class of 400s and stale-prior bugs.
- `refusal` and `pause_turn` are the two stop reasons that produce baffling hangs when unhandled — compile-time exhaustiveness makes new values a build failure.
- Capability flags keep Claude-specific strengths (cache breakpoints, effort, system-role injection) first-class without `if (provider === 'anthropic')` scattered through the loop.

## Consequences

- (+) Model migrations become type-system-guided edits.
- (−) A future provider that genuinely needs sampling params requires a deliberate, typed extension (per-adapter options) rather than a passthrough — intentional friction.

## Alternatives Considered

- **Generic `providerOptions: Record<string, unknown>` passthrough** — hides the features that make the harness good and reintroduces silent 400s; rejected.
