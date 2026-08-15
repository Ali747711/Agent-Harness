# PLAN.md — CLI AI Coding Agent Harness

> Working name: **(TBD)**  
> Status: Planning  
> Language: TypeScript  
> Target: Production-grade local CLI coding agent (Claude Code–class)

---

## 1. What This Project Is

This project is a **local, terminal-native AI coding agent harness** — a production system that turns large language models into a capable software engineer that runs on the developer’s machine.

It is **not**:

- A simple chat wrapper around an LLM API
- An IDE plugin only
- A research prototype or demo agent
- A hosted/cloud-only product

It **is**:

- A long-running CLI process that understands a codebase, edits files, runs commands, searches, and iterates until a task is done
- An **agentic harness**: the deterministic infrastructure (tools, permissions, context, loop, extensibility) around the model
- Designed to start with **Claude models** and later support additional providers
- Built for real daily use by developers and teams, with configuration, safety, and extensibility comparable to Claude Code

The core product promise:

> Describe what you want in natural language. The agent reads the repo, plans, edits code, runs tests/builds, fixes failures, and can commit — while staying under your control via permissions, hooks, and project conventions.

---

## 2. Goals & Non-Goals

### Goals

- **Local-first**: runs on the user’s machine, full access to the project filesystem and shell (under permission controls)
- **High-quality coding agent**: multi-file edits, search, execution, verification loops
- **Solid harness infrastructure**:
  - Structured context management
  - Reliable tool calling and validation
  - Permissions and safety gates
  - Session persistence and resume
- **Extensibility** similar to Claude Code:
  - Project memory (`CLAUDE.md` / `AGENTS.md`-style)
  - Skills
  - Hooks
  - MCP servers
  - Subagents
  - Plugins / packaging
- **Multi-model ready**: Claude first; clean abstraction for other models later
- **Production quality**: logging, observability, tests, config scopes, auditability
- **TypeScript-native**: aligned with the stack the team already prefers and with proven CLI agent patterns

### Non-Goals (for now)

- Replacing the entire IDE experience (optional IDE integration can come later)
- Fully autonomous unattended production deploys without human gates
- Training or fine-tuning models
- Building a general multi-agent framework unrelated to coding
- Perfect feature parity with Claude Code on day one

---

## 3. Inspiration & Reference

Primary reference: **Claude Code** (Anthropic) — terminal agentic coding tool with:

- Agentic loop (gather context → take action → verify)
- Built-in tools (file ops, search, shell, web, code intelligence)
- Extensions: CLAUDE.md, skills, hooks, MCP, subagents, plugins, agent teams
- Strong emphasis on the *harness* (tools + context + permissions), not only the model

Also informed by patterns from open agents (Aider, Cline, OpenCode, etc.) and public analysis of coding-agent architecture: simple loop, rich tools, context engineering, isolation via subagents, deterministic safety outside the prompt.

---

## 4. Core Concepts

| Concept | Role |
|--------|------|
| **Agentic loop** | Repeated cycle: model reasons → may call tools → harness executes → results return → until done or needs user |
| **Harness** | Everything around the model: tools, context pipeline, permissions, UI, config, persistence |
| **Tools** | Capabilities the model can invoke (read/write files, grep, bash, etc.) with schemas and permission rules |
| **Context** | What the model sees each turn (system prompt, project memory, history, tool results) — managed carefully |
| **Skills** | Packaged workflows/knowledge (markdown + optional scripts), invocable or model-selected |
| **Hooks** | Deterministic actions at lifecycle events (e.g. before/after tool use, session start/stop) |
| **MCP** | Model Context Protocol — connect external tools and data sources as first-class tools |
| **Subagents** | Isolated agent runs with their own context; return summaries to the parent |
| **Permissions** | Policy layer that decides allow / ask / deny for tool actions |
| **Project memory** | Files like `CLAUDE.md` / `AGENTS.md` that inject always-on project conventions |

---

## 5. High-Level Architecture

```
CLI / TUI (Ink + React)
        │
        ▼
Agent Runtime (loop, streaming, cancellation)
        │
        ├── Context pipeline (load → budget → compact)
        ├── Model client (Claude first, multi-provider later)
        ├── Tool dispatcher + permission gate
        ├── Skills / Hooks / MCP / Subagents
        └── Session store + config
                │
                ▼
        Host: filesystem, shell, git, network (permissioned)
```

### Main components

1. **CLI / TUI** — Interactive terminal UI: input, streaming output, tool progress, permission prompts  
2. **Agent loop** — Single clear loop; model decides tool use; harness executes and feeds results back  
3. **Tools** — Validated, permissioned, concurrency-aware tool implementations  
4. **Context management** — System + project memory + history + tool results; compaction and offloading  
5. **Extensibility layer** — Skills, hooks, MCP client, subagents, plugins  
6. **Config & memory** — User / project / local scopes; session resume; optional auto-memory  
7. **Safety** — Permissions, workspace boundaries, optional sandbox, checkpoints (e.g. git)

---

## 6. Technology Choices

| Area | Choice | Rationale |
|------|--------|-----------|
| Language | **TypeScript** | Team preference; strong typing for tools/config; matches Claude Code–style stacks |
| Runtime | **Bun** (or Node 22+) | Fast CLI startup, native TS, solid tooling |
| Terminal UI | **React + Ink** (or maintained equivalent) | Streaming, multi-panel status, permission dialogs |
| Validation | **Zod** | Tool inputs, config, shared schemas → JSON Schema for the model |
| Primary LLM | **Anthropic Claude** (via official SDK) | Best initial coding quality; expand later |
| MCP | Official **TypeScript MCP client** | Standard for external tools |
| Persistence | SQLite and/or JSONL sessions | Resume, history, audit |
| Testing | Vitest + integration tests around the loop | Reliability of tools and permissions |

---

## 7. Feature Set (Target)

### MVP / Phase 1

- Interactive CLI session in a project directory  
- Streaming model responses  
- Core tools: Read, Write, Edit, Glob, Grep, Bash  
- Zod validation + basic permission mode (ask on writes / shell)  
- Load project memory file(s) into context  
- Session save / resume  
- Minimal TUI (input + streaming + tool status)

### Phase 2 — Production baseline

- Context budgeting and compaction  
- Hooks (PreToolUse, PostToolUse, SessionStart, Stop, …)  
- Skills (directory + `SKILL.md`, slash or model-triggered)  
- Better edit strategy and large-result offloading  
- Git-friendly checkpoints / undo story  
- Structured config (user / project / local)  
- Logging and basic cost/token metrics

### Phase 3 — Extensibility

- MCP client (stdio / HTTP as needed)  
- Subagents (`Task`-style tool, isolated context, summary return)  
- Plugin packaging (skills + hooks + MCP + agent defs)  
- Multi-model provider abstraction  

### Phase 4 — Scale & polish

- Optional LSP / code intelligence  
- Parallel execution for safe tools  
- Agent teams / coordination (optional)  
- Stronger sandboxing and policy engine  
- Observability, eval harness, documentation for teams  

---

## 8. Design Principles

1. **Harness over prompt** — Safety, permissions, and tool behavior are enforced in code, not only in system instructions.  
2. **Simple loop, rich periphery** — Prefer one clear agent loop; put power in tools, skills, hooks, and subagents.  
3. **Context is scarce** — Progressive disclosure, compaction, offload to files, isolate heavy work in subagents.  
4. **Tools are products** — Descriptions, schemas, error messages, and result size limits are first-class design work.  
5. **User stays in control** — Interruptible, permission prompts, checkpoints, clear audit trail.  
6. **Local-first, team-ready** — Works for one developer; config and plugins scale to shared repos.  
7. **Claude first, models later** — Ship quality on Claude; keep provider boundary clean for expansion.  

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Context blow-up / degraded reasoning | Compaction pipeline, tool-result limits, subagent isolation |
| Unsafe shell / file actions | Permission modes, path sandboxing, optional OS/container sandbox, hooks |
| Tool calling unreliability | Strict Zod schemas, clear tool descriptions, retries with structured errors |
| Scope creep vs Claude Code parity | Phased roadmap; ship usable MVP before full extensibility |
| Multi-model behavior differences | Provider abstraction + per-model tool/prompt tuning later |
| Long-running session cost | Token/cost logging, compaction, model tier routing (strong vs fast) |

---

## 10. Success Criteria (initial)

- A developer can open the CLI in a real repo, ask for a non-trivial change, and the agent completes it with minimal hand-holding (read → edit → test → fix).  
- Permissions and project memory demonstrably change behavior in a controllable way.  
- Sessions can be interrupted and resumed without losing essential state.  
- Adding a skill or MCP server does not require changing core loop code.  
- The codebase is structured so a second model provider can be added without rewriting the harness.

---

## 11. Open Decisions (for discussion)

- Final product name and CLI binary name  
- Exact project-memory filename convention (`CLAUDE.md` vs `AGENTS.md` vs both)  
- Default permission mode and enterprise policy story  
- Bun vs Node as primary supported runtime  
- How aggressive auto-compaction should be vs user-visible “compact” command  
- Depth and isolation model for subagents (in-process vs subprocess vs worktree)  
- Licensing and whether core is open source  

---

## 12. Suggested Discussion Agenda

1. Confirm vision: local Claude Code–class harness, not a thin chat CLI  
2. Agree TypeScript + Bun/Ink direction  
3. Prioritize Phase 1 MVP scope (which tools, which UI fidelity)  
4. Permissions & safety bar for v0  
5. Naming, repo layout, and ownership  
6. Timeline and who owns which layers (loop, tools, TUI, MCP, etc.)

---

## 13. One-Sentence Summary

**We are building a production TypeScript CLI harness that wraps frontier models (starting with Claude) in a reliable agentic loop with tools, permissions, context management, skills, hooks, MCP, and subagents — so developers get a local coding agent that can actually ship work in real repositories.**
