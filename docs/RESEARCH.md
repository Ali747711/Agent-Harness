# RESEARCH.md — Prior Art, Tools & Platform Capabilities

> Companion to [PLAN.md](./PLAN.md) · Researched: 2026-08-15
> Purpose: ground every PLAN.md decision in what already exists — comparable projects, harness design lessons, libraries, and current Claude platform features.

---

## 1. Executive Summary — Top Findings

1. **The harness we describe in PLAN.md already exists as a product category with 5+ mature open-source implementations** (OpenCode ~197k★, Codex CLI ~106k★, pi ~90k★, Cline ~66k★, Gemini CLI, Crush, Goose, Aider). None of them needs to be beaten on day one, but all of them are free reference architectures. The differentiator is harness quality, not novelty.

2. **The single biggest strategic decision is build-vs-buy at the loop level.** Anthropic ships the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — literally Claude Code's engine as a TypeScript library: agent loop, Read/Write/Edit/Bash/Glob/Grep/WebSearch tools, context management + compaction, permissions, hooks, subagents, sessions, MCP, skills, plugins. Building *on* it collapses Phases 1–3 of PLAN.md into configuration; building *without* it means owning the loop but re-implementing everything. See §6 for the trade-off analysis (including branding/licensing constraints).

3. **Every serious harness converged on the same architecture**: one simple main loop, flat message history, at most one level of subagent nesting, agentic search (ripgrep) instead of RAG, model-tier routing (cheap model for utility calls), and deterministic safety enforced in code. Our PLAN.md §8 principles are validated by evidence — see §3.

4. **The client/server split is the modern pattern.** OpenCode (server + thin TUI client over SSE), Codex CLI (core engine + JSON-RPC app server), and Gemini CLI (packages/cli vs packages/core) all separate the agent runtime from the terminal UI. This is what makes "resume", IDE integration, and web clients cheap later. PLAN.md's architecture diagram should adopt this explicitly.

5. **The Claude API now does several PLAN.md Phase-2 jobs server-side**: compaction (beta), context editing, prompt-cache-safe mid-conversation system messages, tool search with deferred loading, task budgets, and a token-counting endpoint. The harness should be designed so these are pluggable — see §5.

6. **Sandboxing is a solved dependency, not a research project.** Anthropic open-sourced `@anthropic-ai/sandbox-runtime` (srt): OS-level filesystem/network restriction (Seatbelt on macOS, bubblewrap on Linux, proxy-based network filtering), no containers. Codex CLI proves kernel-level enforcement is a differentiator worth having.

---

## 2. The Landscape — Comparable Projects

| Project | Stars* | Lang / Stack | Architecture | What to steal |
|---|---|---|---|---|
| **Claude Code** (Anthropic) | closed | TS, Ink+React | Single main loop, flat history, subagents via Task tool | The whole extension model: CLAUDE.md, hooks, skills, plugins, permission modes, checkpoints. See §3. |
| **OpenCode** ([anomalyco/opencode](https://github.com/sst/opencode)) | ~197k | TS on **Bun**, Hono server, SQLite/Drizzle, Go/OpenTUI client | **Client/server**: server owns state + LLM + tools; clients attach over HTTP REST + SSE | Server-first design; provider neutrality (Models.dev registry); session persistence schema |
| **Codex CLI** ([openai/codex](https://github.com/openai/codex)) | ~106k | **Rust** (rewritten from TS) | Layers: CLI → TUI → core engine → JSON-RPC app server → sandbox layer | Kernel-level sandboxing (Seatbelt / Landlock+seccomp / restricted tokens); AGENTS.md convention |
| **pi** ([earendil-works/pi](https://github.com/badlogic/pi-mono), Mario Zechner) | ~90k | TS monorepo: pi-ai / pi-agent-core / pi-tui / coding-agent | Minimal core: **4 tools** (read, write, edit, bash), JSONL **tree sessions** (`id`/`parentId` → in-place branching), TS extensions for everything else | The best-documented minimal harness. Steering queue (Enter = steer now, Alt+Enter = after done). Deliberate omissions list (no MCP/subagents/todos in core — all via extensions) |
| **Gemini CLI** ([google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)) | large | TS + **Ink/React**, npm workspaces | `packages/cli` (UI) / `packages/core` (orchestration, PolicyEngine, SandboxManager); config class as DI container; event-driven | Closest stack to our plan (TS + Ink). Their [architecture doc](https://google-gemini.github.io/gemini-cli/docs/architecture.html) is a free blueprint; tool confirmation flow (read-only skips approval) |
| **Cline** ([cline/cline](https://github.com/cline/cline)) | ~66k | TS | Ships as SDK + IDE extension + CLI from one core | Plan/Act mode split; checkpoint via shadow git |
| **Aider** ([aider.chat](https://aider.chat)) | mature | Python | Repo-map (tree-sitter + graph ranking), git-native | Repo-map idea for large-codebase context; edit-format benchmarking discipline (polyglot benchmark) |
| **Goose** (Block → Linux Foundation) | mature | Rust | MCP-native extension model | Governance path for open source |
| **Crush** (Charm) | mature | Go, Bubble Tea | Multi-provider, LSP, MCP | LSP integration reference |

\* Star counts from GitHub search on 2026-08-15; treat as order-of-magnitude.

**Landscape reviews:** [Terminal Trove comparison table](https://terminaltrove.com/compare/ai-coding-agents/) · [Pinggy: best open-source CLI agents](https://pinggy.io/blog/best_open_source_cli_coding_agents/) · [OpenCode architecture deep-dive](https://falexm.medium.com/inside-opencode-understanding-the-architecture-behind-the-ai-runtime-01236d9370ff)

### Read-order recommendation

1. **pi** — smallest complete harness; read its coding-agent package end to end ([README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)).
2. **Gemini CLI** — same stack we're planning (TS/Ink); read `packages/core` tool scheduling + policy engine.
3. **OpenCode** — server/client split, Bun+Hono+SQLite production patterns.
4. **Codex CLI** — sandboxing layer only (Rust otherwise less transferable).

---

## 3. What Makes Claude Code Good — Distilled Harness Lessons

Primary source: [MinusX — "What makes Claude Code so damn good"](https://minusx.ai/blog/decoding-claude-code/) (intercepted and logged every network request over months). Cross-validated by Anthropic's own engineering posts.

### Control loop
- **One main thread, flat message history, max one branch.** Subagents (Task tool) cannot spawn subagents. Results come back as tool results in the flat history. Debuggability beats orchestration cleverness.
- **Explicit todo list** maintained by the model itself — counters context rot on long tasks, keeps the model on-objective, enables mid-course correction. Reinforced via `<system-reminder>` injections ("your todo list is empty…").
- **Steering queue**: user input mid-run is queued and injected between tool cycles (pi replicates this: Enter = steer, Alt+Enter = follow-up after completion).

### Context economics (measured numbers)
- System prompt ≈ **2.8k tokens**; tool descriptions ≈ **9.4k tokens**; CLAUDE.md adds ~1–2k. Tool descriptions are the biggest fixed spend — they are product surface, not boilerplate.
- **>50% of LLM calls go to the cheap model** (Haiku tier): file summarization, git history parsing, one-word status labels, conversation summarization. Model-tier routing is a first-class harness feature, not an optimization.
- **No RAG.** Agentic search with ripgrep/jq/find, driven by the model. Transparent, no chunking/similarity failure modes.

### Tool design
- **Mixed granularity on purpose**: low (Bash, Read, Write) + medium (Edit, Grep, Glob) + high (Task, WebFetch, exit_plan_mode). Frequency of use justifies promotion to a dedicated tool; dedicated tools give the harness typed hooks to gate, render, audit, and parallelize (bash gives you an opaque string).
- Prompt steering still uses emphasis ("IMPORTANT", "NEVER") and `<good-example>/<bad-example>` blocks — with newer models, dial back aggressiveness.

### Safety & recovery
- Permission modes enforced **in code**, not prompts; hooks for deterministic lifecycle behavior; automatic checkpoints with Esc-Esc rewind (restore code, conversation, or both).

### Long-running harness pattern
From [Anthropic — Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents):
- Split **initializer agent** (scaffolds environment: feature list, init script, progress log, baseline commit) from **coding agent** (incremental sessions: read progress → baseline test → one feature → verify → commit).
- Durable state lives in **external structured artifacts**, not the context window: JSON feature list (JSON chosen because the model overwrites it less carelessly than Markdown), progress file, git history.
- Verification loops at session start and per-feature (including browser automation for UI work).

---

## 4. Required Reading — Annotated

**Anthropic engineering (canonical):**
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) — workflows vs agents; start simple; the agent = model + tools + loop framing.
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — compaction, structured note-taking, subagent isolation; "find the smallest set of high-signal tokens."
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — high-leverage tools (not API wrappers), namespacing, human-readable results, pagination/truncation budgets, eval-driven tool iteration.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — see §3.
- [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices) — CLAUDE.md conventions, permission workflows, headless mode.
- [Enabling Claude Code to work more autonomously](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously) — checkpoints, subagents, hooks rationale.
- [Dynamic workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code) — orchestrating subagents at scale.

**Community analyses:**
- [MinusX — Decoding Claude Code](https://minusx.ai/blog/decoding-claude-code/) — the single best external analysis (see §3).
- [Thorsten Ball — How to Build an Agent](https://ampcode.com/notes/how-to-build-an-agent) — the canonical "agent in <400 lines" tutorial; proves the loop is trivial and the harness is the product.
- [12-Factor Agents (HumanLayer)](https://github.com/humanlayer/12-factor-agents) — esp. Factor 3 (own your context window; recall degrades in the middle 40–60% of a large window) and Factor 8 (own your control flow: pause/resume by serializing context).
- [Gemini CLI architecture](https://google-gemini.github.io/gemini-cli/docs/architecture.html) + [DeepWiki packages breakdown](https://deepwiki.com/google-gemini/gemini-cli/1.2-package-structure).
- [pi coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) — deliberate-omissions philosophy.
- [Codex CLI sandboxing analysis](https://zread.ai/openai/codex/13-macos-seatbelt-and-windows-sandbox).

---

## 5. Claude Platform Capabilities the Harness Should Exploit

Current models (verified 2026-08):

| Model | ID | Context / Max out | $/MTok in/out | Harness role |
|---|---|---|---|---|
| Claude Opus 5 | `claude-opus-5` | 1M / 128K | $5 / $25 | **Default main-loop model** |
| Claude Fable 5 | `claude-fable-5` | 1M / 128K | $10 / $50 | Opt-in "smartest" tier (always-on thinking; refusal fallbacks recommended) |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M / 128K | $3 / $15 (intro $2/$10) | High-volume / interactive tier |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K / 64K | $1 / $5 | **Utility calls** (summaries, labels, file digests) — the Claude Code pattern |

API surface notes that change harness design (all verified against current docs):

- **Thinking is adaptive now** — `thinking: {type: "adaptive"}` (on Opus 5, omitting it already runs adaptive). `budget_tokens` is removed on current models (400). Depth is controlled by `output_config.effort`: `low…max`, with `xhigh` the recommended coding/agentic setting. The harness's "model config" abstraction should be (model, effort), not (model, temperature) — **sampling params are rejected on Opus 5-class models**.
- **Prompt caching is the economics of the whole product.** Prefix-match; render order tools → system → messages. Harness rules: frozen system prompt (no timestamps/interpolation), deterministically sorted tool list, breakpoint at stability boundaries, 1h TTL for long sessions, verify via `usage.cache_read_input_tokens`. Agentic-loop gotcha: cache lookback is 20 content blocks — long tool-heavy turns need intermediate breakpoints.
- **Cache-safe dynamic context**: on Opus 5 / Opus 4.8 / Fable 5, mid-conversation `{"role": "system"}` messages append operator instructions *after* the cached prefix — the correct mechanism for our system-reminder-style injections. Fallback on other models: `<system-reminder>` text in a user turn.
- **Mid-conversation tool changes** (beta `mid-conversation-tool-changes-2026-07-01`): add/remove tools between turns without invalidating cache (`defer_loading` + `tool_addition` blocks). This is how MCP servers can attach mid-session cheaply.
- **Server-side compaction** (beta `compact-2026-01-12`) and **context editing** (beta, clears old tool results/thinking): both can replace or complement client-side compaction. Design the context pipeline as a strategy interface so client-side summarization (full control, works with any provider) and server-side compaction (zero code) are swappable.
- **Tool search** (`tool_search_tool_regex_20251119` + `defer_loading`): with many MCP tools, don't load all schemas — this is the platform-native version of the "deferred tools" pattern.
- **Strict tool use** (`strict: true` + `additionalProperties: false`): guaranteed schema-valid `tool_use.input`. Combine with Zod validation for defense in depth.
- **Fine-grained tool streaming** (GA, `eager_input_streaming: true` per tool): stream Edit/Write inputs into the TUI as they generate.
- **Token counting**: `POST /v1/messages/count_tokens` — never tiktoken (undercounts Claude by 15–20%+). Context budgeting must use this or response `usage` fields.
- **Task budgets** (beta): token ceiling the model paces itself against — useful for a `/budget` feature.
- **Refusal handling**: Opus 5/Fable 5 can return HTTP 200 with `stop_reason: "refusal"` — the loop must branch on `stop_reason` before reading content; opt into server-side `fallbacks: "default"` for Fable 5.
- **Batches API** (50% price) for offline harness work (eval runs, bulk summarization).

**Multi-provider layer (PLAN.md "Claude first, models later"):** the loop should consume an internal `ModelClient` interface. Candidates to wrap later: Vercel AI SDK (broadest), pi-ai (@earendil-works/pi-ai — lightweight, agent-oriented), or hand-rolled per-provider adapters (OpenCode uses Models.dev as a provider/model registry). Do **not** adopt an abstraction on day one that hides Claude-specific features (caching breakpoints, adaptive thinking, effort, system-role injections) — those are exactly the features that make the harness good.

---

## 6. Build-vs-Buy: Claude Agent SDK vs Own Harness

Anthropic's own taxonomy (from the API docs) — four ways to build an agent:

| Option | Harness | Deployment | Fits our plan? |
|---|---|---|---|
| Manual loop (Anthropic SDK) | you build | you host | Max control, max work |
| **Tool Runner** (`client.beta.messages.toolRunner`) | SDK runs the loop over *your* tools; per-turn hooks for approval/interception/retries | you host | **Strong middle path** — keeps us owning tools/permissions/context while outsourcing loop mechanics |
| **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | full Claude Code harness: built-in tools, permissions, hooks, subagents, sessions, MCP, skills, plugins ([docs](https://code.claude.com/docs/en/agent-sdk/overview)) | you host | Fastest to "working product"; least differentiation |
| Managed Agents (REST) | Anthropic | Anthropic | Not local-first — out of scope |

**Arguments for building on the Agent SDK:** PLAN.md Phases 1–3 nearly for free; battle-tested loop/compaction; bundles a native Claude Code binary; loads `.claude/` config (CLAUDE.md, skills, hooks) identically.

**Arguments against (and they're significant given PLAN.md's identity):**
1. *The harness is the product.* PLAN.md §1 defines the project as building the deterministic infrastructure. On the Agent SDK, we'd be building a TUI + config wrapper around someone else's harness.
2. *Multi-model is a core goal* (PLAN.md §2). The Agent SDK is Claude-only by construction; the Tool Runner and manual loop keep the provider boundary ours.
3. *Licensing/branding*: Agent SDK use is governed by Anthropic's Commercial Terms; product must not appear to be Claude Code; no claude.ai-login passthrough for third-party products. Fine for internal tooling, constraining for an open/distributable product.
4. *The loop is the cheap part* (Thorsten Ball: <400 lines). The expensive parts — tools, permissions, context pipeline, TUI, extensibility — we'd have to design anyway to differentiate.

**Recommendation:** own the loop (manual loop, optionally bootstrapped with the Tool Runner for Claude), own tools/permissions/context; treat the Agent SDK as (a) a reference spec for feature parity and (b) a possible *backend option* behind the same TUI later. Revisit only if velocity becomes the binding constraint.

---

## 7. Library Choices per Layer

| Layer (PLAN.md §5) | Recommendation | Alternatives / notes |
|---|---|---|
| Runtime | **Bun** — 8–15ms startup vs Node's 40–120ms; `bun build --compile` single binary; `bun:sqlite`, `Bun.spawn` built in; OpenCode ships on it | Node 22+ if ecosystem compatibility trumps (node:sqlite still experimental, SEA less mature). Decision interacts with TUI choice below |
| TUI | **Ink 6** (React) — proven at scale: Claude Code, Gemini CLI, GitHub Copilot CLI, Wrangler | **OpenTUI** (Bun+Zig FFI, React/Solid renderers, no 30fps cap, flexbox, lower memory) — faster but younger ecosystem, Bun-only ([comparison](https://betterstack.com/community/guides/scaling-nodejs/opentui-react/)). Start Ink, keep rendering behind a thin adapter |
| Validation / schemas | **Zod 4** — native `z.toJSONSchema()` (no zod-to-json-schema dep); one schema → runtime validation + model-facing JSON Schema + TS types | Add `strict: true` + `additionalProperties: false` on the wire |
| LLM client | **@anthropic-ai/sdk** direct (streaming, caching, betas) behind our `ModelClient` interface | Vercel AI SDK / pi-ai later for other providers (§5) |
| MCP | **@modelcontextprotocol SDK v2** — note the monolith split into `@modelcontextprotocol/client` + `/server`; spec `2026-07-28` RC is stateless; support stdio + Streamable HTTP ([SDK](https://github.com/modelcontextprotocol/typescript-sdk), [v2 betas](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/)) | Pin spec revision explicitly; older servers negotiate down to 2025-11-25 |
| Search | Vendored **ripgrep** (`@vscode/ripgrep`) — what Claude Code ships | Never build RAG for code search (§3) |
| Shell | `Bun.spawn` / execa; **node-pty** only if interactive PTY sessions needed | Background tasks via a task registry, or pi's answer: tmux |
| Persistence | **JSONL transcripts** (append-only, resumable, auditable — Claude Code + pi pattern; pi's `id`/`parentId` tree enables branching/rewind in one file) + **SQLite** for index/metadata (`bun:sqlite` or better-sqlite3; Drizzle if ORM wanted — OpenCode does) | JSONL is the source of truth; SQLite is derived |
| Sandbox | **@anthropic-ai/sandbox-runtime (srt)** — Seatbelt (macOS) / bubblewrap (Linux) + proxy-based network filtering, no containers ([repo](https://github.com/anthropic-experimental/sandbox-runtime)) | Codex-style Landlock/seccomp if we ever go native; containers as opt-in escape hatch |
| Diff/edit | Exact string-replace edits (Claude Code Edit semantics) + unified-diff fallback; `diff` npm for rendering | Aider's benchmark data shows edit-format choice measurably moves success rate — make it swappable and eval it |
| Token counting | Anthropic `count_tokens` endpoint + response `usage` accounting | Never tiktoken |
| Testing | Vitest; loop-level integration tests with a mock ModelClient; record/replay transcripts for regression | terminal-bench-style E2E later (§8) |
| CLI plumbing | commander (or citty); picocolors | |

---

## 8. Safety & Evals

**Safety stack (layered):**
1. Permission engine in code — allow/ask/deny per tool + path/command matchers; modes like Claude Code (default / acceptEdits / plan / bypass). Read-only tools skip confirmation (Gemini CLI pattern).
2. Path confinement — canonicalize every model-supplied path, reject escapes from workspace root (symlinks, `..`, encoded traversal).
3. OS sandbox via srt for bash — filesystem + network egress restriction without containers.
4. Checkpoints — auto-snapshot before mutations; rewind code/conversation/both (Claude Code Esc-Esc; Cline's shadow-git is the cheap implementation).
5. Hooks — user-defined deterministic gates (PreToolUse can block).

**Evals (Phase 4, but decide format early):**
- [terminal-bench 2.1](https://www.tbench.ai/leaderboard/terminal-bench/2.1) — the benchmark *for harnesses* (model + harness evaluated together; frontier agents < 65%). Our loop should be runnable headless (`-p` style + JSON output) from day one so it can be benchmarked.
- SWE-bench Verified (model-centric, harness matters), Aider polyglot (edit-format quality).
- Internal: record/replay JSONL transcripts as golden tests for loop behavior — cheapest regression suite.

---

## 9. Implications for PLAN.md Open Decisions (§11)

| Open decision | Research says |
|---|---|
| Bun vs Node | **Bun.** Startup (8–15ms vs 40–120ms) matters for a CLI; single-binary distribution; bun:sqlite; OpenCode validates it in production; unlocks OpenTUI later. Cost: occasional Node-ecosystem incompatibility — keep CI running the test suite on Node too if we stay runtime-neutral in code |
| Project memory filename | Support **both** `CLAUDE.md`-style and `AGENTS.md` (Codex/industry convention), plus our own name as primary. Cheap: it's a load-path list |
| Default permission mode | Ask-on-writes/shell (Gemini/Claude Code default); read-only tools auto-approved. Sandbox (srt) as the "safe yes" that reduces prompting fatigue |
| Auto-compaction aggressiveness | Client-side summarization triggered around ~80–90% of budget **plus** user-visible `/compact`; keep server-side compaction (beta) as a pluggable strategy. Keep durable state out of context entirely (JSON task file, progress notes — §3) |
| Subagent isolation model | **In-process, one level deep, restricted toolset, results as tool-results in flat history** (the Claude Code model). Worktree/subprocess isolation later for parallel writes. This must be decided pre-Phase-1 because the session store must represent it |
| Naming / licensing | If distributing publicly and using the Agent SDK anywhere, respect Anthropic branding terms (must not appear to be Claude Code). Own-loop path avoids the constraint entirely |

**Suggested PLAN.md amendments:**
1. Add "client/server split" (runtime process + thin TUI attach) to §5 — the pattern all three big TS/Rust harnesses converged on; enables resume, IDE, and web clients later.
2. Add "headless mode with JSON output" to Phase 1 (not Phase 4) — it's the eval + scripting surface, trivially cheap early and painful to retrofit.
3. Add "model-tier routing" (utility calls on Haiku) to Phase 2 — >50% of Claude Code's calls are the cheap model; it's a cost feature users feel immediately.
4. Record the build-vs-buy decision (§6) as an ADR before any code.

---

## 10. Source Index

**Anthropic:** [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) · [Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) · [Long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) · [Agent SDK TS repo](https://github.com/anthropics/claude-agent-sdk-typescript) · [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) · [Checkpointing docs](https://platform.claude.com/docs/en/agent-sdk/file-checkpointing) · [Claude Code autonomy](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)

**Analyses:** [MinusX decoding Claude Code](https://minusx.ai/blog/decoding-claude-code/) · [Thorsten Ball / Amp](https://ampcode.com/notes/how-to-build-an-agent) · [12-factor agents](https://github.com/humanlayer/12-factor-agents) · [Codex sandboxing](https://zread.ai/openai/codex/13-macos-seatbelt-and-windows-sandbox) · [codex-rs architecture](https://codex.danielvaughan.com/2026/03/28/codex-rs-rust-rewrite-architecture/) · [OpenCode internals](https://falexm.medium.com/inside-opencode-understanding-the-architecture-behind-the-ai-runtime-01236d9370ff) · [OpenCode DeepWiki](https://deepwiki.com/sst/opencode) · [Gemini CLI architecture](https://google-gemini.github.io/gemini-cli/docs/architecture.html) · [Gemini CLI DeepWiki](https://deepwiki.com/google-gemini/gemini-cli) · [pi coding-agent](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md) · [pi review](https://andrew.ooo/posts/pi-coding-agent-minimal-terminal-harness-review/)

**Libraries/benchmarks:** [MCP TS SDK](https://github.com/modelcontextprotocol/typescript-sdk) · [MCP 2026-07-28 SDK betas](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/) · [OpenTUI vs Ink](https://betterstack.com/community/guides/scaling-nodejs/opentui-react/) · [Bun vs Node 2026](https://strapi.io/blog/bun-vs-nodejs-performance-comparison-guide) · [terminal-bench](https://www.tbench.ai/leaderboard/terminal-bench/2.1) · [Landscape comparisons](https://terminaltrove.com/compare/ai-coding-agents/)
