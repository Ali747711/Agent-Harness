# PHASE1-PLAN.md — Implementation Plan: Phase 1 (MVP)

> Status: **Accepted — in progress** · Date: 2026-08-15
> Inputs: [PLAN.md](./PLAN.md) (strategy) · [RESEARCH.md](./RESEARCH.md) (prior art & platform) · [docs/adr/](./adr/) (ADR-0001…0010, the decided constraints)
> Produced via the planner workflow · Approved 2026-08-15.

## Overview

Phase 1 delivers a working, locally-installable coding agent: a Bun-native TypeScript harness that owns its agent loop, executes six file/search/shell tools under a code-enforced permission engine, persists sessions as append-only JSONL, and exposes the same runtime through two clients — an Ink 6 interactive TUI and a headless JSONL/JSON event stream. The goal is not feature parity with Claude Code; it is a **correct, testable spine** with every Phase 2–4 seam (compaction, sandbox, hooks, MCP, subagents, second provider) already cut into the right place.

The organizing principle: **one runtime core, all client communication through a serializable event protocol**. Headless mode is the proof that the protocol is real — if it can be written to stdout as JSONL, it can later be sent over SSE to an IDE or web client without touching the loop.

---

## 1. Requirements — What MVP Must Do End-to-End

Refined from PLAN.md §7 against the decided constraints (ADR-0001…0010). Stated as user-visible capabilities.

| # | Capability | Acceptance |
|---|---|---|
| R1 | **Interactive session** — run `harness` in a project directory, get a TUI with an input box, streamed assistant text, visible thinking, and live tool status lines | Multi-turn conversation completes without UI corruption or dropped output |
| R2 | **Agentic task completion** — agent reads files, searches the repo, edits code, runs commands, reads failures, and iterates until done | A non-trivial task ("add a flag, wire it up, run the test, fix the failure") completes in one prompt in a real repo |
| R3 | **Enforced permissions** — read-only tools auto-approve; writes and shell prompt with allow-once / allow-for-session / deny; paths outside the workspace root are hard-denied and cannot be allowed by any rule | Adversarial path test table passes; permission prompt appears inline in TUI and as a protocol event in headless |
| R4 | **Project memory** — `CLAUDE.md` / `AGENTS.md` (configurable filename list, hierarchical from workspace root) loaded at session start into the frozen system prompt | Adding an instruction to `CLAUDE.md` demonstrably changes agent behavior in a repeatable test |
| R5 | **Session persistence + resume** — every session auto-writes a JSONL transcript; `harness --continue`, `harness --resume <id>`, `harness sessions list` | Kill the process mid-session, resume, and the agent has full prior context including tool results |
| R6 | **Headless mode** — `harness -p "prompt" --output-format text\|json\|jsonl`, non-interactive, non-zero exit on failure, deterministic event stream on stdout, diagnostics on stderr | Same task produces equivalent results in headless and TUI; output is machine-parseable for evals |
| R7 | **Interruptible + steerable** — Ctrl-C / Esc cancels the current turn cleanly and leaves the session resumable; typing while the agent runs queues a steering message injected at the next safe boundary | No orphaned child processes, no half-written files, no corrupt JSONL after interrupt |
| R8 | **Model configuration** — `(model, effort, thinking)` via flags and config file; streaming always on; no temperature/top_p anywhere in the codebase | `--model claude-sonnet-5 --effort xhigh` works; passing a sampling param is a config validation error |
| R9 | **Token + cost accounting** — per-turn and per-session input/output/cache-read/cache-write tokens and USD cost, sourced from API `usage` fields only | Displayed in TUI status line and emitted in `turn_completed` events |
| R10 | **Legible failure** — refusals, rate limits, `max_tokens`, overload, tool errors, and permission denials each surface with a distinct message and a suggested next action | One test per `stop_reason` and per error class; no unhandled promise rejections reach the user |
| R11 | **Single-binary distribution** — `bun build --compile` produces one executable; cold start to first prompt under ~150 ms | Timed on macOS and Linux in CI |

**Non-functional:** core has zero UI dependencies (no React/Ink import reachable from `packages/core`); all Bun-specific API use is confined to one adapter module; 80% line coverage overall, 85%+ on `permissions/`, `tools/`, `agent/`, `session/`.

---

## 2. Explicit Scope Cuts

Deliberately **not** in Phase 1. Each has a seam so it can land without loop surgery.

| Cut | Justification |
|---|---|
| Context compaction / budgeting | 1M context makes it rarely binding in MVP; `ContextPipeline` interface ships now so the strategy swaps in Phase 2 |
| Hooks (PreToolUse, etc.) | Requires a stable lifecycle surface; shipping it now would freeze the protocol before real usage informs it |
| Skills (`SKILL.md`) | Depends on hooks + slash-command infrastructure that does not exist yet |
| MCP client | Phase 3; mid-conversation tool changes (beta) make late attachment cheap, so paying for it now buys nothing |
| Subagents / Task tool | Phase 3; Phase 1 pays only the session-format reservation (agent-scoped entries) which is ~20 lines |
| OS sandbox (`@anthropic-ai/sandbox-runtime`) | Phase 2; Phase 1's `CommandRunner` seam makes it a single implementation swap. MVP safety = human-in-the-loop, and this is documented honestly |
| Checkpoints / Esc-Esc rewind | The `parentId` entry tree makes it possible later; the UX and shadow-git layer are a Phase 2 project |
| Model-tier routing (Haiku utility calls) | A cost optimization, not a capability; adds a second model path and cost-attribution complexity for zero MVP function |
| Todo tool | High value, but it is a context-rot countermeasure — belongs with compaction in Phase 2 |
| WebSearch / WebFetch | Network egress policy is undesigned until the sandbox lands; a tool that reaches the internet without a policy is a liability |
| Second model provider | Boundary stays clean (`ModelClient`), but implementing a second adapter with no user demand is speculative work |
| Real HTTP/SSE transport + daemon | The in-process event stream with strictly serializable events *is* the client/server split; the transport is a thin Phase 2 adapter. Ports, auth, daemon lifecycle, and reconnect are real cost for no MVP capability |
| Parallel tool execution | Sequential execution is far easier to reason about, audit, and render; the `readOnly` flag is recorded now so batching is a later scheduler change |
| Plan mode / `exit_plan_mode` | Needs a mode state machine plus dedicated UI; Phase 1 ships three modes only (`default`, `acceptEdits`, `bypass`) |
| Image / attachment input | Content-block union is shaped to allow it, but multimodal plumbing through protocol, TUI, and session format is deferred |
| Windows support | Bun, ripgrep vendoring, path semantics, and process-group kill all diverge; macOS + Linux in Phase 1 |
| Git integration (auto-commit, diffs as a tool) | The Bash tool covers git adequately for MVP |
| Slash-command framework | Only a hardcoded minimal set: `/help`, `/clear`, `/exit`, `/resume`, `/cost` |
| Auto-memory / learned facts | Phase 2+; requires memory write policy and user trust model |
| Eval harness (terminal-bench) | Phase 4, but R6 (headless JSONL) is the prerequisite and ships now |

---

## 3. Repo Layout

**Bun workspaces monorepo, two packages in Phase 1.** The monorepo is not for publishing convenience — it exists to make the dependency direction *mechanically enforceable*: `core` can never import the UI, and future clients (IDE, web) attach to `core` without inheriting Ink.

```
harness/
├─ package.json                  # workspaces: ["packages/*"]; scripts; packageManager: bun
├─ bunfig.toml
├─ tsconfig.base.json            # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├─ biome.json
├─ vitest.config.ts
├─ .github/workflows/ci.yml      # bun test + `tsc --noEmit` under Node 22 (portability canary)
├─ docs/
│  ├─ PLAN.md
│  ├─ RESEARCH.md
│  ├─ PHASE1-PLAN.md
│  └─ adr/                       # 0001..0010
├─ fixtures/
│  ├─ cassettes/                 # recorded Anthropic SSE streams (redacted)
│  ├─ golden/                    # normalized AgentEvent snapshots
│  └─ workspaces/                # tiny synthetic repos for tool + E2E tests
└─ packages/
   ├─ core/                      # @harness/core — headless runtime. No react, no ink, no process.stdout writes.
   │  └─ src/
   │     ├─ protocol/            # AgentEvent, ClientCommand, PROTOCOL_VERSION. Pure types + Zod guards.
   │     ├─ agent/               # AgentSession, turn state machine, steering queue, cancellation
   │     ├─ model/
   │     │   ├─ client.ts        # ModelClient interface + normalized request/stream types
   │     │   ├─ anthropic/       # @anthropic-ai/sdk adapter (the ONLY module that imports it)
   │     │   └─ mock/            # MockModelClient: scripted turns + fault injection
   │     ├─ tools/
   │     │   ├─ tool.ts          # Tool interface, ToolContext, ToolResult
   │     │   ├─ registry.ts      # deterministic ordering, Zod → JSON Schema wire specs
   │     │   └─ builtin/         # read, write, edit, glob, grep, bash
   │     ├─ permissions/         # engine, rule parsing/matching, workspace guard, command matchers
   │     ├─ context/             # ContextPipeline, SystemPromptBuilder, memory loader, token ledger
   │     ├─ session/             # JSONL store, entry tree, SQLite index, resume/path resolution
   │     ├─ config/              # Zod config schema + scope resolution (defaults→user→project→env→flags)
   │     ├─ exec/                # CommandRunner interface + DirectCommandRunner (srt seam)
   │     ├─ runtime/             # Bun↔Node adapter: spawn, sqlite, fs, paths, hashing
   │     ├─ logging/             # structured logger + secret redaction
   │     ├─ errors/              # typed error taxonomy
   │     └─ index.ts             # public surface: createSession(), protocol types, config
   └─ cli/                       # @harness/cli — the bin, both clients
      └─ src/
         ├─ main.ts              # entry; routes to headless or TUI
         ├─ args/                # commander definitions, flag → config mapping
         ├─ headless/            # AgentEvent → stdout (text | json | jsonl); exit codes
         ├─ render/              # Renderer adapter interface (Ink today, OpenTUI swappable)
         ├─ state/               # PURE reducer: AgentEvent[] → ViewModel. No Ink import. Heavily unit-tested.
         └─ ui/                  # Ink 6 components — dumb, props-only, render the ViewModel
```

**Rules encoded in CI:**
1. `packages/core` may not import `react`, `ink`, or anything from `packages/cli`. Enforced by a lint rule plus a CI grep.
2. `Bun.*` and `bun:*` imports are permitted **only** inside `packages/core/src/runtime/`. This keeps Node portability a three-file change rather than a rewrite.
3. `@anthropic-ai/sdk` may be imported **only** inside `packages/core/src/model/anthropic/`. The loop must never see a vendor type.

**Why not three packages (splitting `tui`)?** Workspace friction for zero Phase-1 benefit. The rendering adapter boundary lives at `cli/src/render/`, and extraction later is a directory move. Revisit if a second client ships.

---

## 4. Core Seam Interfaces — Define These First

These six contracts are written (and reviewed) before implementation. For each: responsibility, key surface, and — most importantly — **what it must not do**, since the leak-prevention rules are where the architecture actually lives.

### 4.1 `ModelClient` (`core/src/model/client.ts`)

**Responsibility:** convert a normalized request into a normalized event stream. Nothing else. No retry policy decisions, no history management, no tool execution.

**Key surface:**
- `stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>`
- `countTokens?(req: ModelRequest): Promise<number>` — optional capability, backed by `/v1/messages/count_tokens`
- `capabilities: { systemRoleMessages: boolean; adaptiveThinking: boolean; effortLevels: Effort[]; maxCacheBreakpoints: number }` — lets the context pipeline branch without `if (provider === 'anthropic')` scattered around

**`ModelRequest`:** `{ model, effort, thinking, maxTokens, system: SystemBlock[], tools: ToolSpec[], messages: Message[], cacheBreakpoints }`. Note the deliberate absence of `temperature` / `top_p` — they are not representable in the type (ADR-0010).

**`ModelStreamEvent`** (discriminated union): `message_start` · `text_delta` · `thinking_delta` · `tool_use_start` · `tool_use_input_delta` · `tool_use_complete` · `message_stop { stopReason, usage }` · `error`.

**`StopReason`:** `'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'pause_turn'` — exhaustively switched in the loop with a TypeScript `never` check so a new value is a compile error.

**Must not:** leak an SDK type past the module boundary; hide Claude-specific features behind a lowest-common-denominator abstraction (cache breakpoints, effort, adaptive thinking, and system-role messages are first-class in `ModelRequest`, not escape-hatch `providerOptions`); implement retry (that is the loop's policy).

### 4.2 `Tool` / `ToolRegistry` (`core/src/tools/`)

**Responsibility:** declare a capability's schema and its *effects*, then perform it. The critical design point: **`plan()` is separate from `execute()`**.

**Key surface:**
- `name`, `description` (product surface — this is ~9k tokens of fixed spend across six tools; budget it)
- `schema: z.ZodType<I>` (Zod 4)
- `readOnly: boolean` — drives default permission and future parallel scheduling
- `plan(input, ctx): PermissionRequest` — pure; declares paths touched (with read/write mode) and the command to be run. No side effects.
- `execute(input, ctx): Promise<ToolResult>` — receives **only canonicalized, pre-approved handles**, never raw model-supplied path strings
- `renderTitle(input): string` — one-line summary for TUI status and headless text output

**Why the split:** it makes permission enforcement structural. A tool physically cannot act on an effect it did not declare, because the guard hands `execute` the resolved handles and the tool has no other way to obtain them. It also lets the TUI show "will write to `src/foo.ts`" *before* approval.

**`ToolResult`:** `{ ok: true, content, display?, metadata } | { ok: false, error: ToolError }`. Failures return as `tool_result` with `is_error` so the model self-corrects; they are never thrown into the loop.

**`ToolRegistry`:** `register`, `get`, `list()` returning specs sorted by name, `toWireSpecs()` emitting `z.toJSONSchema()` output with `strict: true` and `additionalProperties: false`, serialized by a canonical stringifier so byte output is stable across runs.

**Must not:** perform I/O in `plan()`; access the filesystem outside `ToolContext`; produce unbounded output (every tool has a size budget and an explicit truncation marker naming how to fetch more).

### 4.3 `PermissionEngine` (`core/src/permissions/`)

**Responsibility:** a pure decision function over `(PermissionRequest, mode, rules, session grants)`.

**Key surface:**
- `evaluate(req, ctx): PermissionDecision` → `{ kind: 'allow' | 'deny' | 'ask', reason, matchedRule? }`
- `recordGrant(req, scope: 'once' | 'session'): void`
- Modes: `default` (read-only auto, writes/shell ask) · `acceptEdits` (file writes auto, shell still asks) · `bypass` (everything auto, requires an explicit scary flag and prints a banner)

**Precedence:** `WorkspaceGuard` pre-check (non-overridable) → explicit `deny` rules → session grants → explicit `allow` rules → mode default → `ask`. Any evaluation error fails **closed** to `deny`.

**`WorkspaceGuard`** is a separate, non-bypassable module: canonicalize via `realpath` (for non-existent targets, realpath the nearest existing ancestor and re-join), compare at path-segment boundaries (`/work` must not match `/workspace-evil`), reject symlink escapes, handle macOS case-insensitivity. **No rule can approve a path outside the workspace root in Phase 1** — a config typo cannot become an arbitrary-write bug.

**Bash policy, stated honestly:** Phase 1 does not parse shell into a "safe subset" — that is a rabbit hole that produces false confidence. Instead: ask by default with the full command shown; prefix-matcher rules for user opt-in allowlists (`Bash(git status:*)`); a small deny-list of catastrophic patterns documented explicitly as a *backstop, not a security boundary*. The real boundary is the Phase 2 sandbox.

**Must not:** be reachable from inside a tool (only the loop calls it); depend on I/O (so the whole thing is table-testable); allow a rule to override the workspace guard.

### 4.4 `ContextPipeline` (`core/src/context/`)

**Responsibility:** turn session state into a cache-optimal `ModelRequest`, and account for tokens.

**Key surface:**
- `build(state: SessionState): Promise<ModelRequestContext>` — system blocks, messages, cache breakpoint placement
- `observeUsage(usage: Usage): void` — the token ledger; API fields only, never tiktoken
- `shouldCompact(): boolean` — Phase 1 returns `false` always; Phase 2 swaps the implementation

Phase 1 ships `PassthroughPipeline`. The interface exists now so `CompactingPipeline` and `ServerSideCompactionPipeline` are drop-ins.

**Cache rules it must guarantee (each is a test):**
- System blocks are **byte-identical** across every turn of a session. Environment facts (cwd, OS, date, git branch) are snapshotted **once at session start** and frozen. Re-rendering the git branch every turn silently destroys the cache and is the single easiest way to lose the product's economics.
- Tool specs are sorted by name and serialized with stable key order.
- Render order is tools → system → messages, with a breakpoint at the stable prefix boundary plus a rolling breakpoint near the message tail.
- Long tool-heavy turns get an intermediate breakpoint (cache lookback is 20 content blocks).

**`DynamicContextInjector`** (sub-module): anything that changes — reloaded memory, system-reminders, environment drift — is injected **late in messages**, using `{role: 'system'}` mid-conversation messages where `capabilities.systemRoleMessages` is true, falling back to `<system-reminder>` text in a user turn otherwise.

**Must not:** mutate history in place (append-only, immutable); interpolate anything time-varying into the system prompt; estimate tokens locally.

### 4.5 `SessionStore` (`core/src/session/`)

**Responsibility:** append-only JSONL as the source of truth; SQLite purely as a derived index.

**Key surface:**
- `create(meta): Promise<SessionHandle>`
- `append(sessionId, entry: SessionEntry): Promise<void>`
- `read(sessionId): AsyncIterable<SessionEntry>`
- `resolvePath(sessionId, leafId?, agentScope?): Promise<SessionEntry[]>` — walk the `parentId` chain to a linear history
- `list(filter): Promise<SessionSummary[]>` (SQLite-backed)
- `reindex(sessionId?): Promise<void>` — rebuild SQLite from JSONL

**`SessionEntry`:** `{ id, parentId: string | null, ts, type, agentId, parentAgentId?, ...payload }` with `type ∈ user | assistant | thinking | tool_call | tool_result | permission | system | meta`. The `id`/`parentId` tree (pi pattern) is what makes branching and rewind possible later without a format migration.

**Subagent reservation (the one thing that must be right now):** entries carry `agentId`. `resolvePath` filters by agent scope from day one. In Phase 1 only the root agent exists, so the filter is a no-op — but when Phase 3 lands, a subagent's internal entries live in the same JSONL while the main thread's resolved history contains only the summarizing `tool_result`. This costs ~20 lines now and avoids a transcript migration later.

**Storage:** `~/.harness/projects/<slug>-<hash>/<sessionId>.jsonl`, index at `~/.harness/index.db`. Out-of-repo by default so transcripts are never accidentally committed.

**Durability:** append + fsync at turn boundaries (not per line). Readers must tolerate and skip a trailing malformed line from a crash mid-write — this is a real, testable edge case.

**Must not:** treat SQLite as authoritative (a test deletes the DB, reindexes, and asserts equality); rewrite or compact JSONL files in place.

### 4.6 Event Protocol — Core ↔ Clients (`core/src/protocol/`)

**Responsibility:** the total surface between runtime and any client. Both Phase-1 clients consume exactly this and nothing else.

**Client → Core (`ClientCommand`):** `prompt` · `steer` (queued mid-run) · `interrupt` · `permission_response { requestId, choice }` · `shutdown`.

**Core → Client (`AgentEvent`):** `session_started { sessionId, protocolVersion, model, workspaceRoot, memoryFiles }` · `turn_started` · `assistant_text_delta` · `assistant_thinking_delta` · `tool_call_started { callId, tool, title, input }` · `tool_call_progress { callId, chunk }` (streams bash stdout) · `tool_call_completed { callId, ok, summary, durationMs }` · `permission_requested { requestId, callId, request, suggestions }` · `permission_resolved { requestId, choice, by: 'user' | 'rule' }` · `turn_completed { stopReason, usage, costUsd }` · `error { severity, code, message, recoverable }` · `session_idle`.

**Invariants:**
1. Every event is JSON-serializable with no functions, class instances, or cycles. Headless mode is `JSON.stringify` per line — that is the enforcement mechanism, and it is why headless belongs in Phase 1 rather than Phase 4.
2. `protocolVersion` is emitted in `session_started` and bumped on breaking change.
3. Core never writes to stdout; clients own all output.
4. Backpressure is the client's problem — core emits every delta (headless needs them all); the TUI adapter coalesces per frame.

---

## 5. Build Order

Sequenced so a runnable end-to-end slice exists at **step 4** and grows outward. Each step lists what is built, what it depends on, and how it is verified.

### Phase 1A — Walking Skeleton (M1)

**1. Repo scaffold and de-risking spike** — S
- *Build:* Bun workspaces, `packages/core` + `packages/cli`, strict tsconfig, Biome, test runner, CI (bun test + Node 22 `tsc --noEmit`), dependency-direction lint rule.
- *Spike first (timebox 2 hours):* Ink 6 + React rendering under Bun; `@vscode/ripgrep` binary resolution under Bun; `bun:sqlite`. These are the three plausible Bun ecosystem gaps; finding a wall here is far cheaper than at step 13.
- *Depends on:* nothing.
- *Verify:* `bun test` and `bun run typecheck` green in CI; spike renders an Ink "hello" and shells out to the vendored `rg` successfully.

**2. Protocol, errors, config** — S
- *Build:* `protocol/` event and command unions with Zod guards and `PROTOCOL_VERSION`; `errors/` taxonomy; `config/` Zod schema and scope resolution (defaults → `~/.harness/config.json` → `<project>/.harness/config.json` → env → flags); `runtime/` adapter stubs.
- *Depends on:* 1.
- *Verify:* round-trip test — every event variant survives `JSON.parse(JSON.stringify(e))` and re-validates; config precedence table test; `harness config show` prints the resolved config with sources.

**3. ModelClient interface + Anthropic adapter + MockModelClient** — M
- *Build:* the interface from §4.1; `AnthropicModelClient` (streaming SSE → normalized events, effort/thinking mapping, cache-control markers, usage extraction, beta headers); `MockModelClient` with scripted turn programs and fault injection (each `stop_reason`, mid-stream error, malformed tool input).
- *Depends on:* 2.
- *Verify:* unit tests drive the adapter's parser from recorded cassettes; mock client tests assert every scripted variant; one live smoke test (tagged, excluded from default run) hits the real API.

**4. Agent loop v0 (no tools) + headless client** — M
- *Build:* `AgentSession` turn state machine (`idle → building → streaming → terminal`), exhaustive `stop_reason` branching including `pause_turn` re-request and `max_tokens` handling, `AbortSignal` cancellation, `maxTurns` guard; `cli/src/headless/` with `text | json | jsonl` formats and exit codes.
- *Depends on:* 3.
- *Verify:* `harness -p "say hi" --output-format jsonl` against the mock emits the exact expected event sequence; against the real API it streams a real answer; Ctrl-C mid-stream exits 130 cleanly with no unhandled rejection.

> **M1 reached.** Headless one-shot answer, end to end.

### Phase 1B — Tools and Permissions (M2)

**5. SessionStore — JSONL layer** — M
- *Build:* entry types with the `id`/`parentId`/`agentId` tree, append writer with turn-boundary fsync, streaming reader tolerant of a truncated trailing line, `resolvePath` with agent scoping, path layout under `~/.harness/projects/`.
- *Depends on:* 2. Wired into the loop from 4.
- *Verify:* write→read→resolve round-trip; deliberately truncate the last line and assert graceful recovery; assert every loop event that should persist produces exactly one entry.

**6. Tool interface, registry, and read-only tools (Read, Glob)** — M
- *Build:* `Tool`/`ToolContext`/`ToolResult`; registry with deterministic ordering and `z.toJSONSchema` wire specs (`strict: true`, `additionalProperties: false`, canonical serialization); **Read** (line-numbered output, offset/limit pagination, byte cap with truncation notice, binary detection → typed refusal); **Glob** (ripgrep `--files` fast path, mtime-sorted results, cap).
- *Depends on:* 5. Read-only tools first, deliberately, so tool plumbing lands before permission complexity.
- *Verify:* per-tool unit tests over `fixtures/workspaces/`; a byte-equality test asserting the wire spec output is stable across two registry constructions.

**7. Tool execution in the loop** — M
- *Build:* `tool_use` → Zod validation → `plan()` → execute → `tool_result` → continue; sequential execution; structured tool errors returned to the model (never thrown); per-tool result budgets; `tool_call_*` events emitted.
- *Depends on:* 6.
- *Verify:* scripted mock drives a two-tool turn and the golden event stream matches; a malformed tool input produces a `tool_result` error that the mock's next turn can react to (proves the self-correction path).

**8. WorkspaceGuard + PermissionEngine** — L
- *Build:* canonicalization and confinement (§4.3), rule syntax and matchers, mode defaults, session grants, decision precedence, fail-closed error handling; `permission_requested` / `permission_response` round-trip through the protocol; headless `--permission-mode` and auto-deny behavior.
- *Depends on:* 7.
- *Verify:* the adversarial path table (`../`, absolute escapes, symlink-to-outside, `/work` vs `/workspace-evil`, percent-encoded, null byte, deep `..` chains, macOS case variants) — every case asserted; mode × rule × request decision table; a headless run with `--permission-mode default` blocks a write and exits with the documented code.

**9. Write and Edit tools** — M
- *Build:* **Write** (atomic temp-then-rename, parent-dir creation gated by permission, diff captured for display); **Edit** (exact string replace; error if `old_string` absent; error if ambiguous and `replace_all` false, with a hint to add surrounding context); the **read-before-write invariant** — session tracks `readFiles` with mtime+hash, and editing a file not read this session, or changed since read, is a typed error asking for a re-read.
- *Depends on:* 8.
- *Verify:* unit tests for no-match, multi-match, stale-mtime, CRLF preservation, trailing-newline preservation, unicode; an interrupt during write leaves the original file intact (atomic rename proof).

**10. CommandRunner seam + Bash tool** — M
- *Build:* `CommandRunner` interface with `DirectCommandRunner` (`Bun.spawn` via `runtime/`); cwd pinned to workspace, environment scrubbed of `ANTHROPIC_API_KEY` and similar secrets, own process group, SIGTERM→SIGKILL on cancel, default 120 s timeout, output cap preserving head and tail, stdout streamed as `tool_call_progress`.
- *Depends on:* 8.
- *Verify:* timeout test, non-zero exit test, 10 MB output truncation test, cancel test asserting no orphan process survives (check process group), env-scrub assertion.

**11. Grep tool** — S/M
- *Build:* vendored ripgrep via `@vscode/ripgrep` with a system-`rg` fallback; **argv array construction only, never shell string interpolation**; modes `files_with_matches | content | count`, glob/type filters, context lines, multiline, head limit, result cap with "N more matches" notice.
- *Depends on:* 6, 10.
- *Verify:* fixture-repo search assertions; an injection test proving a pattern containing shell metacharacters is passed literally.

> **M2 reached.** The tool loop reads, searches, and edits files under enforced permissions.

### Phase 1C — Context and Memory

**12. ContextPipeline, system prompt, project memory, token ledger** — M
- *Build:* `PassthroughPipeline`; `SystemPromptBuilder` producing a frozen system prompt (identity, tool-use guidance, environment snapshot taken once); memory loader for a configurable filename list (`CLAUDE.md`, `AGENTS.md`, plus product-specific), hierarchical from workspace root with size caps; cache breakpoint placement including the intermediate breakpoint for long tool turns; `DynamicContextInjector`; token/cost ledger from `usage`.
- *Depends on:* 5, 7.
- *Verify:* **byte-equality test** — build the request on turn 1 and turn 5, assert the system+tools prefix is identical; cassette-backed test asserting `usage.cache_read_input_tokens > 0` on turn 2; a behavioral test where a `CLAUDE.md` instruction changes mock-observable request content; cost math checked against a fixed price table.

### Phase 1D — TUI and Resume (M3)

**13. Rendering adapter + Ink 6 TUI** — L
- *Build:* `Renderer` adapter interface at `cli/src/render/`; **pure reducer** at `cli/src/state/` mapping `AgentEvent[]` → `ViewModel` (zero Ink imports); Ink components — scrollback via `<Static>` for completed output with only the live tail re-rendering, input box with history, streaming text and thinking panes, tool status lines with spinner and result summary, inline permission dialog, status bar (model, tokens, cost, elapsed), Ctrl-C / Esc interrupt, steering queue (Enter queues and interrupts at the next safe boundary; Alt+Enter queues as a follow-up).
- *Depends on:* 4, 8, 12. **Can be built in parallel from step 4 onward against `MockModelClient`** — the main parallelization opportunity for a two-person team.
- *Verify:* reducer unit tests cover every event type (this is where the coverage lives); `ink-testing-library` frame assertions for streaming, tool status, and the permission dialog; a synthetic 10,000-delta benchmark asserting bounded CPU and no dropped frames; manual check on a real task.

**14. SQLite index + resume** — M
- *Build:* `bun:sqlite` index (id, project root, timestamps, title, message count, token totals, last entry id, model), `harness sessions list`, `--resume <id>`, `--continue`, `reindex`.
- *Depends on:* 5, 13.
- *Verify:* kill mid-session, `--continue`, assert resolved history matches pre-kill state and the next turn registers a cache hit; delete `index.db`, reindex, assert `list()` output is unchanged.

> **M3 reached.** Interactive TUI session with memory, permissions, and resume.

### Phase 1E — Hardening and Ship (M4)

**15. Error handling and resilience hardening** — M
- *Build:* retry with exponential backoff and jitter on 429/500/529 with `retry-after` respected; explicit `refusal` handling and user-facing message; `max_tokens` continuation; `pause_turn` resumption; network-drop mid-stream recovery; a single top-level handler that turns any escaped error into a protocol `error` event; secret redaction in logs.
- *Depends on:* 13.
- *Verify:* mock fault-injection test per error class; assert no unhandled rejection under a fuzz of injected stream failures; assert the session remains resumable after each failure class.

**16. Golden transcript suite and coverage gate** — M
- *Build:* `stableEvents()` normalizer (strips ids, timestamps, durations, absolute paths) — without this, goldens flake on the first run; 8–12 recorded scenarios covering read-only Q&A, single edit, multi-file edit, bash failure→fix loop, permission denial, interrupt, resume, refusal; cassette recording script with key redaction; coverage gate in CI.
- *Depends on:* 15.
- *Verify:* the suite runs offline in under 30 seconds and fails loudly on any behavior change; coverage ≥80% overall and ≥85% on the four critical modules.

**17. Packaging, docs, ADR finalization** — S/M
- *Build:* `bun build --compile` for macOS arm64/x64 and Linux x64; install script; `--version` / `--help`; README with quickstart; ADR statuses flipped to Accepted; a `SAFETY.md` stating plainly that Phase 1 relies on human approval and that OS sandboxing arrives in Phase 2.
- *Depends on:* 16.
- *Verify:* binary runs on a clean machine with no Bun installed; cold-start timing measured in CI; a fresh-user walkthrough completes without consulting source.

> **M4 reached.** Shippable v0.1.

---

## 6. Testing Strategy

**Layer 1 — `MockModelClient` (the workhorse).** Scripted turn programs: `mock.script([{ text, toolCalls: [...] }, { text: 'done' }])`. Every loop test uses it; zero network, zero cost, fully deterministic. Fault injection covers each `stop_reason`, mid-stream disconnects, malformed tool inputs, and empty responses. **Rule: no test outside `model/anthropic/` may touch the network.**

**Layer 2 — Cassettes (adapter fidelity).** Real Anthropic SSE streams recorded to `fixtures/cassettes/*.jsonl` with keys redacted, replayed through `AnthropicModelClient`'s parser. This is the only thing that catches "the API changed shape" without paying for live calls. Refreshed deliberately, with a recording script.

**Layer 3 — Golden transcripts (loop regression).** Run a scenario in a temp workspace with a scripted mock, capture the emitted `AgentEvent` stream, normalize with `stableEvents()`, and diff against a committed snapshot. The cheapest high-value regression net available (RESEARCH §8), and it tests the *protocol*, so it is client-agnostic.

**Layer 4 — Tool unit tests.** Per tool against `fixtures/workspaces/`: happy path, not-found, permission-denied, path-escape, truncation boundary, binary/encoding, CRLF, very large file, concurrent modification, Edit no-match and multi-match, Bash timeout / non-zero exit / huge output / cancel.

**Layer 5 — Permission table tests.** The engine is pure, so it gets an exhaustive table: `(mode, rules, sessionGrants, request) → expected decision`. Adversarial path cases enumerated in step 8. This table is where security actually lives; adding a case must be a one-line change so it grows with every discovered edge.

**Layer 6 — Cache-stability tests.** Byte-equality of the cached prefix across turns; breakpoint placement assertions; a cassette-backed assertion that `cache_read_input_tokens > 0` on turn 2. Cache regressions are silent and expensive — this is the only thing that catches them.

**Layer 7 — Session round-trip tests.** Write/read/resolve; truncated-trailing-line tolerance; SQLite rebuilt from JSONL equals the live index.

**Layer 8 — TUI tests.** The pure reducer carries the coverage burden (`AgentEvent[]` → `ViewModel`, no Ink). Ink components get shallow `ink-testing-library` frame assertions only. Plus the 10k-delta rendering benchmark.

**Layer 9 — Live smoke E2E.** Tagged, excluded from the default run, executed pre-release: real API, real temp repo, a small end-to-end task. Costs money, so it is deliberately rare.

**Gate:** 80% overall, 85%+ on `permissions/`, `tools/`, `agent/`, `session/`. Enforced in CI.

---

## 7. Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Prompt-cache invalidation from silent nondeterminism** (timestamps, git branch, Map iteration order, unsorted tools). Silent, expensive, easy to introduce. | High | Freeze the system prompt at session start; sort tools by name; canonical JSON serializer; byte-equality test (step 12) plus a live `cache_read_input_tokens > 0` assertion. Any PR touching `context/` must show the cache test green. |
| 2 | **Permission bypass** — path traversal, symlink escape, or TOCTOU between `plan()` and `execute()`. | High | Single choke point: tools receive only canonicalized handles from `WorkspaceGuard`, never raw model strings; **re-canonicalize at execute time** to close TOCTOU; workspace pre-check non-overridable by any rule; deny-wins precedence; fail-closed on evaluation error; exhaustive adversarial table. |
| 3 | **Bash is the hole in the fence until Phase 2.** No OS sandbox in MVP. | High | Ask-by-default with the full command displayed; no shell parsing (no false confidence); env scrubbed of secrets; cwd pinned; timeout and output cap; process-group kill. `CommandRunner` seam makes srt a one-implementation swap. Stated plainly in `SAFETY.md` — the honest framing is the mitigation. |
| 4 | **Ink rendering performance under high-frequency streaming** — full re-render at a 30 fps cap causes flicker and CPU burn on long outputs. | Medium-High | Coalesce deltas into a frame buffer (~30–60 ms); completed output goes to `<Static>` so only the live tail re-renders; 10k-delta CI benchmark with a bounded-CPU assertion; the `Renderer` adapter is the escape hatch to OpenTUI if Ink caps out. |
| 5 | **Bun ecosystem gaps** — Ink/React, `@vscode/ripgrep` postinstall, `bun:sqlite`, test-runner divergence. | Medium-High | Spike all three in step 1 before committing (2-hour timebox); confine `Bun.*` to `runtime/` so Node fallback is a three-file change; CI runs Node 22 `tsc --noEmit` as a portability canary; ripgrep resolution falls back to system `rg`. |
| 6 | **Cancellation correctness** — Ctrl-C mid-tool leaving partial writes, orphan processes, or corrupt JSONL. | Medium-High | `AbortSignal` threaded through every async path; atomic temp-then-rename writes; child processes in their own group with SIGTERM→SIGKILL; JSONL entries written only after operation completion; explicit tests for each. |
| 7 | **Tool-call reliability** — hallucinated paths, ambiguous Edit targets, clobbering unread files. | Medium | `strict: true` + `additionalProperties: false` on the wire, Zod re-validation for defense in depth; structured actionable errors returned as `tool_result` so the model self-corrects; Edit requires a unique match and errors with candidate context; read-before-write invariant with mtime+hash. |
| 8 | **`stop_reason` handling gaps** — `pause_turn` and `refusal` are easy to miss and produce baffling hangs. | Medium | Exhaustive `switch` with a TypeScript `never` check (new values become compile errors); one mock test per reason; never a silent `default: continue`. |
| 9 | **Two-client behavioral drift** — logic that should live in core creeping into the TUI. | Medium | Enforced dependency rule (`cli → core` only, CI-checked); golden tests run against the event stream, so any behavior not in the protocol is invisible to them and therefore untested — which surfaces the drift immediately. |
| 10 | **Development cost and rate limits** — long agentic loops on Opus 5 at $5/$25 per MTok. | Medium | Mock-first testing with live tests behind a tag; per-session token/cost accounting visible from step 12; hard `maxTurns` and a session token ceiling. |
| 11 | **Scope creep into Phase 2** — compaction, hooks, and skills all feel "almost free" once the seams exist. | Medium | The §2 cut list is part of the plan of record; seams are designed so deferring costs nothing; milestone gates are demo-based, not feature-count-based. |
| 12 | **Session format regret** — discovering at Phase 3 that subagents do not fit the transcript. | Medium | `agentId` / `parentAgentId` reserved now with agent-scoped `resolvePath` (step 5); a format-version field on every entry so a migration is at least possible. |

---

## 8. Complexity Estimates

| Step | Description | Size |
|---|---|---|
| 1 | Repo scaffold + de-risking spike | S |
| 2 | Protocol, errors, config | S |
| 3 | ModelClient + Anthropic adapter + Mock | M |
| 4 | Agent loop v0 + headless client | M |
| 5 | SessionStore JSONL layer | M |
| 6 | Tool interface, registry, Read, Glob | M |
| 7 | Tool execution in the loop | M |
| 8 | WorkspaceGuard + PermissionEngine | L |
| 9 | Write + Edit tools | M |
| 10 | CommandRunner + Bash | M |
| 11 | Grep | S/M |
| 12 | ContextPipeline + system prompt + memory + tokens | M |
| 13 | Rendering adapter + Ink TUI | L |
| 14 | SQLite index + resume | M |
| 15 | Error handling and resilience | M |
| 16 | Golden suite + coverage gate | M |
| 17 | Packaging, docs, ADR finalization | S/M |

**Sizing convention:** S ≈ 0.5–1 day, M ≈ 2–3 days, L ≈ 4–5 days, for one experienced TypeScript developer including tests.

**Rough total:** ≈ **36–45 focused developer-days**.
- Solo: **7–9 calendar weeks**.
- Two developers: **4–5 calendar weeks** — the TUI track (step 13) runs in parallel from step 4 onward against `MockModelClient`; the tool track (6, 9, 10, 11) parallelizes against the permission track once step 8's interface is agreed.

The two largest single items (8 and 13) are also the two highest-risk; schedule them where there is slack, not against a deadline.

---

## 9. Milestones

Each milestone is defined by a **demo**, not a feature count.

### M1 — Headless one-shot answer (steps 1–4)
**Demo:** `harness -p "explain what this repo does" --output-format text` streams a real answer from Claude; `--output-format jsonl` emits the full serialized event stream; Ctrl-C exits cleanly.
**Proves:** loop, `ModelClient`, protocol serializability, streaming, cancellation, `stop_reason` handling.
**Done when:** the same command works against the mock in CI and against the live API manually; every event round-trips through JSON.

### M2 — Tool loop edits a file under permissions (steps 5–11)
**Demo:** in a scratch repo, `harness -p "add a --version flag to src/cli.ts, then run the tests and fix any failure"` — the agent greps, reads, edits, runs bash, reads the failure, edits again. In `default` mode it requests permission and blocks; in `acceptEdits` it proceeds. A prompt asking it to write to `/etc/hosts` is hard-denied.
**Proves:** tools, tool-result feedback loop, permission engine, path confinement, JSONL persistence.
**Done when:** the adversarial permission table is fully green; a transcript exists on disk that replays to identical history.

### M3 — Interactive TUI session with memory and resume (steps 12–14)
**Demo:** `harness` in a repo containing a `CLAUDE.md`; a multi-turn conversation with streaming, visible tool status, and an inline permission dialog answered with "allow for session"; Ctrl-C interrupts a running turn; quit; `harness --continue` resumes with full history and turn 2 registers a prompt-cache hit.
**Proves:** rendering adapter, event reducer, context pipeline, project memory, cache stability, SQLite index, resume.
**Done when:** the cache-hit assertion passes, the 10k-delta rendering benchmark is within budget, and a real task completes without UI corruption.

### M4 — Shippable v0.1 (steps 15–17)
**Demo:** a downloaded single binary on a machine without Bun runs a real task end to end; failures (rate limit, refusal, tool error) each produce a legible message and a resumable session.
**Proves:** resilience, distribution, documentation.
**Done when:** golden suite green offline in under 30 s, coverage gates met, ADRs accepted, `SAFETY.md` states the Phase-1 threat model honestly, cold start measured under ~150 ms.

---

## 10. Decisions Needed Before Step 1

Small, blocking, and cheap to answer — but each one is baked into paths, package names, or the binary.

1. **Product and binary name.** Blocks package names (`@harness/core` is a placeholder), the config directory (`~/.harness/`), and the memory filename convention (ADR-0009).
2. **Primary memory filename.** Resolved by ADR-0009 once (1) is answered: ordered list `<product>.md` → `AGENTS.md` → `CLAUDE.md`.
3. **Transcript location.** Adopted: `~/.harness/projects/<slug>-<hash>/` (out-of-repo, never accidentally committed). In-repo `.harness/` for team-shared transcripts is a one-line change later.
4. **License and open-source posture.** Own-loop (ADR-0001) avoids Anthropic branding constraints, but this affects whether ADRs, README, and dependency choices are written for a public audience.
5. **Test runner.** Adopted: **Vitest** (ecosystem support incl. ink-testing-library; runs under the Node portability canary), validated during the step-1 spike; `bun:test` remains the fallback if the spike hits friction.

---

## Success Criteria

- [ ] R1–R11 all demonstrably satisfied
- [ ] M1–M4 demos each pass on a clean machine
- [ ] Adversarial permission table green; no path outside the workspace reachable by any rule
- [ ] Prompt-cache hit confirmed on turn 2 of every session; system prefix byte-identical across turns
- [ ] Golden transcript suite runs offline in under 30 seconds and gates CI
- [ ] Coverage ≥80% overall, ≥85% on `permissions/`, `tools/`, `agent/`, `session/`
- [ ] `packages/core` has zero reachable React/Ink imports; `Bun.*` confined to `runtime/`; `@anthropic-ai/sdk` confined to `model/anthropic/`
- [ ] A session survives process kill and resumes with complete history
- [ ] Headless and TUI produce equivalent results for the same task
- [ ] ADR-0001…0010 accepted
- [ ] `SAFETY.md` states the Phase-1 threat model without overclaiming
