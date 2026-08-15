# ADR-0003: Process Architecture — Runtime Core + Thin Clients over a Serializable Event Protocol

- **Status:** Accepted (2026-08-15)
- **Date:** 2026-08-15
- **Context:** [RESEARCH.md §2, §9](../RESEARCH.md) — OpenCode (server + SSE clients), Codex CLI (core + JSON-RPC app server), Gemini CLI (cli/core packages) all converged on this split.

## Decision

The agent runtime lives in `packages/core` with **zero UI dependencies** and communicates with clients exclusively through a versioned, JSON-serializable event protocol (`AgentEvent` / `ClientCommand`). Phase 1 ships two clients over the in-process stream: the Ink TUI and a **headless mode** (`-p`, `--output-format text|json|jsonl`). A real HTTP/SSE transport is a Phase-2 adapter, not an MVP feature.

## Rationale

- Headless JSONL output is the eval surface (terminal-bench-style) and scripting surface; shipping it first forces the protocol to stay serializable — `JSON.stringify` per line is the enforcement mechanism.
- Resume, IDE integration, and web clients become transport work, not loop surgery.
- Two clients from day one prevents UI logic from leaking into the core (golden tests run against the event stream, so untestable drift is surfaced immediately).

## Consequences

- (+) Client-agnostic regression testing; cheap future clients.
- (−) Protocol design discipline required up front (`PROTOCOL_VERSION`, backpressure = client's problem, core never writes stdout).
- (−) Slight indirection overhead for the simple MVP case.

## Alternatives Considered

- **Monolithic CLI** (loop + UI interleaved) — simplest now, expensive forever; rejected.
- **Full daemon with HTTP/SSE in Phase 1** — ports/auth/lifecycle cost with no MVP capability; deferred.
