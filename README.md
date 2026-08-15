# harness

A local, terminal-native AI coding agent — and the production-grade **harness** around the model: tools, permissions, context management, sessions, and extensibility. TypeScript on Bun, Claude-first with a clean provider boundary.

> Working name: `harness` (placeholder). Status: **Phase 1 in progress — M1 reached** (headless one-shot answers against the live API). Not yet a usable coding agent: tools, permissions, and the interactive TUI land in the next milestones.

## What this is

The deterministic infrastructure that turns a frontier model into a coding agent you can trust in a real repo:

- **One simple agent loop** with exhaustive stop-reason handling, retry policy, and cancellation — power lives in the periphery (tools, permissions, context), not in orchestration cleverness
- **A serializable event protocol** between the runtime core and every client — the headless JSONL mode is the proof, and later clients (IDE, web) are transport work, not loop surgery
- **Safety enforced in code**, never in prompts: a permission engine with non-bypassable workspace confinement, plus opt-in OS sandboxing of `bash` via `sandbox-runtime` (Seatbelt / bubblewrap)
- **Append-only JSONL transcripts** as the source of truth — sessions survive `kill -9` and resume with byte-identical model history

It deliberately does **not** wrap the Claude Agent SDK — owning the loop is the point (see [ADR-0001](docs/adr/0001-own-the-agent-loop.md)).

## Milestones

| Milestone | Demo | Status |
|---|---|---|
| **M1** — headless one-shot answer | `harness -p "…" --output-format jsonl` streams a real answer as protocol events | ✅ 2026-08-15 |
| **M2** — tool loop under permissions | Agent greps/reads/edits/runs tests in a real repo; writes gated by the permission engine | 🔨 in progress (steps 5 ✅, 6–11) |
| **M3** — interactive TUI + resume | Ink TUI, project memory, `--continue` with a prompt-cache hit on turn 2 | 🔨 code complete (steps 12–14), pending live verification |
| **M4** — shippable v0.1 | Single binary, golden-transcript suite, hardened errors | 🔨 code complete (steps 15–17) |

Full plan: [docs/PHASE1-PLAN.md](docs/PHASE1-PLAN.md) · strategy: [docs/PLAN.md](docs/PLAN.md) · research: [docs/RESEARCH.md](docs/RESEARCH.md) · decisions: [docs/adr/](docs/adr/)

## Quickstart

Requirements: [Bun](https://bun.sh) ≥ 1.3, an Anthropic API key.

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...
bun packages/cli/src/main.ts
```

That opens the interactive TUI in the current directory. Type a prompt and press Enter; `Ctrl-C` interrupts a running turn (again to quit); permission prompts answer with `y` (once), `a` (this session), `n` (deny). Anything typed while the agent is working is queued and runs next.

One-shot headless mode, for scripting and evals:

```bash
bun packages/cli/src/main.ts -p "explain what an agent loop is" --output-format text
```

Sessions persist as JSONL transcripts and can be resumed:

```bash
bun packages/cli/src/main.ts sessions list
```

```bash
bun packages/cli/src/main.ts --continue
```

Machine-readable event stream (one JSON event per line — the eval/scripting surface):

```bash
bun packages/cli/src/main.ts -p "say hi" --output-format jsonl
```

Useful flags: `--model claude-sonnet-5`, `--effort low|medium|high|xhigh|max`, `--thinking adaptive|disabled`, `--max-tokens`, `--max-turns`, `--cwd`. Exit codes: `0` success, `1` failed, `130` interrupted, `2` usage/config error.

## Sandboxing bash

By default `bash` runs unconfined — it can read and write anything you can. Turning on the
OS sandbox ([Seatbelt](https://developer.apple.com/) on macOS, bubblewrap on Linux) makes the
kernel enforce the workspace boundary instead. Check your machine first:

```bash
bun packages/cli/src/main.ts doctor
```

`doctor` forces the sandbox on and runs real escape attempts through it, reporting what the
kernel actually did — dependency presence is not confinement, only a blocked escape is. If the
probes pass, set `sandbox.enabled` to `true`.

**Egress is denied by default when the sandbox is on.** The runtime has no "allow everything"
setting, so an empty `sandbox.allowedDomains` blocks `npm install`, `git fetch`, and `curl`.
List the domains you need — verified working: an allowlisted host connects while unlisted ones
are refused. See [SAFETY.md](SAFETY.md) for the full threat model.

## Configuration

Resolution order (later wins), with per-key source tracking:

```
defaults → ~/.harness/config.json → <project>/.harness/config.json → HARNESS_* env → CLI flags
```

```jsonc
// .harness/config.json
{
  "model": "claude-opus-5",
  "effort": "xhigh",
  "thinking": "adaptive",
  "maxTokens": 32000,
  "maxTurns": 40,
  "permissionMode": "default",
  "memoryFiles": ["HARNESS.md", "AGENTS.md", "CLAUDE.md"],
  "sandbox": {
    "enabled": false,                 // OS confinement for bash — run `doctor` first
    "allowWrite": [],                 // extra writable roots (workspace + $TMPDIR always)
    "denyRead": [],                   // extra denied reads (credential dirs always)
    "allowedDomains": []              // egress allowlist; EMPTY DENIES ALL NETWORK
  }
}
```

Env vars: `HARNESS_MODEL`, `HARNESS_EFFORT`, `HARNESS_THINKING`, `HARNESS_MAX_TOKENS`, `HARNESS_MAX_TURNS`, `HARNESS_PERMISSION_MODE`, `HARNESS_MEMORY_FILES` (comma-separated).

Two deliberate constraints: **sampling parameters (`temperature`/`top_p`) are not representable** — current Claude models reject them, so the config schema rejects them with a validation error ([ADR-0010](docs/adr/0010-model-config-abstraction.md)); and **the API key is never config-file material** — environment only.

## Repository layout

```
packages/core   # @harness/core — headless runtime: protocol, agent loop, model
                # adapters, config, sessions. Zero UI imports; never writes stdout.
packages/cli    # @harness/cli — the bin: headless client today, Ink TUI in step 13
docs/           # PLAN, RESEARCH, PHASE1-PLAN, adr/0001..0010
fixtures/       # cassettes (recorded SSE streams), golden snapshots, test workspaces
scripts/        # check-boundaries.sh — CI-enforced dependency rules
```

Four boundary rules, enforced in CI: `core` never imports UI; `Bun.*` APIs only inside `core/src/runtime/`; `@anthropic-ai/sdk` only inside `core/src/model/anthropic/`; `@anthropic-ai/sandbox-runtime` only inside `core/src/exec/`.

## Development

```bash
bun run check          # typecheck + lint + boundaries + tests w/ coverage gate
bun run test           # vitest (offline — mock model client + cassette replay)
bun run test:coverage  # same, with the coverage thresholds enforced
bun run test:live      # live API smoke tests (needs ANTHROPIC_API_KEY; costs money)
bun run build:binary   # single executable → dist/harness
bun run format         # biome, write mode
```

Testing approach: no test outside the Anthropic adapter touches the network. The loop runs against a scripted `MockModelClient` (with fault injection for every stop reason, mid-stream failures, and aborts); the adapter's SSE parser replays recorded cassettes through the production path; and a **golden-transcript suite** in [fixtures/golden/](fixtures/golden/) pins 13 end-to-end scenarios at the protocol level, so anything a client displays has to come through there first. Coverage is gated at 80% overall and 85% on `permissions/`, `tools/`, `agent/`, and `session/`.

### Building a binary

```bash
bun run build:binary && ./dist/harness --version
```

The compiled binary needs **ripgrep on `PATH`** (`brew install ripgrep` / `apt install ripgrep`): the vendored copy cannot be embedded in a single-file executable, so search falls back to the system `rg` and says so clearly if it is missing.

Testing approach: no test outside the Anthropic adapter touches the network. The loop is tested against a scripted `MockModelClient` (including fault injection for every stop reason, mid-stream failures, and aborts); the adapter's SSE parser is tested by replaying recorded cassettes through the exact production path. See [PHASE1-PLAN §6](docs/PHASE1-PLAN.md).

## Safety (current state, honestly)

The agent has six tools (read, glob, grep, write, edit, bash) behind a code-enforced permission engine: reads auto-approve, writes and shell commands require a decision, explicit deny rules beat every mode including `bypass`, and evaluation errors fail closed.

Two limits are worth knowing before you point it at anything you care about:

- **The file tools are confined to the workspace root** — `..`, absolute paths, and symlink escapes are rejected by a guard no rule can override.
- **The bash tool is not.** A shell command runs with your user's full privileges and can reach anywhere on the machine; it is gated by *asking you*, not by a boundary. In `bypass` mode that gate is off. OS-level sandboxing lands in Phase 2 behind the `CommandRunner` seam.

Read [SAFETY.md](SAFETY.md) for the full threat model, what each permission mode actually permits, and the recommended posture (short version: run in a clean git repo, prefer `default`, treat `bypass` as "disposable environment").

## License

TBD — private repository while Phase 1 is under construction.
