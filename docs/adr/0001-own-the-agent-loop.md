# ADR-0001: Own the Agent Loop (No Claude Agent SDK Dependency)

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §6](../RESEARCH.md)

## Context

Anthropic ships the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) — Claude Code's engine as a library: loop, built-in tools, permissions, hooks, subagents, sessions, MCP, skills. Building on it would collapse PLAN.md Phases 1–3 into configuration. Building without it means implementing the loop, tools, permissions, and context pipeline ourselves.

## Decision

We implement our own agent loop using `@anthropic-ai/sdk` directly, behind an internal `ModelClient` interface. The Claude Agent SDK is used as a **feature-parity reference spec**, not a dependency.

## Rationale

1. PLAN.md defines the harness as *the product*; on the Agent SDK we would be a TUI wrapper around someone else's harness.
2. Multi-model support is a core goal; the Agent SDK is Claude-only by construction.
3. Agent SDK use carries commercial-terms and branding constraints (must not appear to be Claude Code; no claude.ai-login passthrough) that constrain a distributable product.
4. The loop is the cheap part (<400 LOC canonical); the expensive parts (tools, permissions, context, TUI, extensibility) must be built either way to differentiate.

## Consequences

- (+) Full control over provider boundary, permissions, session format, and extensibility.
- (+) No Anthropic branding/ToS constraints on the product.
- (−) We own compaction, steering, subagent isolation, and reliability work the SDK gives for free.
- (−) Feature-parity pressure: the Agent SDK sets the baseline users expect.
- Revisit trigger: if delivery velocity becomes the binding constraint, the Agent SDK can become an alternate backend behind the same event protocol (ADR-0003).

## Alternatives Considered

- **Claude Agent SDK as the runtime** — fastest to working product; rejected for the reasons above.
- **Anthropic Tool Runner** (`client.beta.messages.toolRunner`) — acceptable bootstrap for the Claude adapter's loop mechanics; rejected as the primary loop because it is beta and Claude-specific. May be used internally by the Anthropic adapter if it simplifies retries/streaming without leaking types.
