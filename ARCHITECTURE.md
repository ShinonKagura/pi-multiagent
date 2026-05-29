# hb-orchestra — Architecture

**Status**: v0.5 design lock — invariants below are NOT negotiable in this version.
**Date**: 2026-05-28
**Provenance**: Fork from `pi-multiagent` v0.10.0 (Tiziano-AI/pi-multiagent + local fixes).

---

## 0. Why a fork? Why a new name?

`pi-multiagent` (Tiziano's package) has explicit design boundaries:
- detached-only execution
- no `Agent()`-style foreground compatibility
- no `.pi/agents/<name>.md` persona reader
- no profile composition / cross-model review as first-class
- intercom integration is non-goal by design

These boundaries are reasonable for Tiziano's product. They are **not** what we need.

`hb-orchestra` is a downstream package with a different product identity:
- detached execution is the **mechanism**, not the API ceiling
- `Agent()`-style foreground convenience + `/agent` slash command
- `.pi/agents/<name>.md` persona reader with `model + fallbackModels`
- Profile composition (chain / parallel multi-agent workflows)
- Harness layer (project-rule injection) and reproducibility ledger
- Optional integration points for `ultimate-pi` patterns + Feynman research

Upstream contributions to `pi-multiagent` (PRs #3/#4/#5 today) remain — they are general-purpose bug fixes that help every consumer. After fork, `hb-orchestra` evolves independently.

---

## 1. Invariants (HARD LOCKS)

These are decisions for v0.5 that cannot be relaxed without a new architecture round.

### I1 — Detached as substrate, NOT as API ceiling

Every long-running operation has a detached lifecycle (start → status → cancel). Foreground convenience wrappers (`Agent()`, `/agent`) MAY exist but they wrap the detached substrate; they do not block the parent process on inner child compute.

> Consequence: parent is never trapped on a hung child. `cancel` is first-class.

### I2 — `Agent()`-tool surface compatibility

A tool named `Agent` (or compat-aliases) is registered. It accepts the pi-subagents-compatible parameter shape (`subagent_type`, `prompt`, `description`, `run_in_background`, `resume`, `inherit_context`, `model`, `thinking`, `max_turns`, `schedule`, `isolation`). Internally maps to a single-step detached graph; returns either result inline (foreground) or `agent_id` immediately (background).

Companion tools: `get_subagent_result`, `steer_subagent`.

> Consequence: existing pi-subagents callers / personas keep working without changes.

### I3 — `.pi/agents/<name>.md` persona reader is first-class

Personas are loaded from (in order):
1. `<cwd>/.pi/agents/<name>.md`
2. `<cwd>/.agents/agents/<name>.md`
3. `~/.pi/agent/agents/<name>.md`
4. `<package>/agents/<name>.md` (built-in library)

Frontmatter format mirrors what already exists in `stellar/.pi/agents/`:
- `model: <provider>/<model-id>` (e.g. `anthropic/claude-sonnet-4-5`)
- `fallbackModels: <list>` — fallback chain on provider failure
- `tools: <list>` — explicit child tool allowlist
- `thinking: <level>` — thinking budget hint
- `systemPromptMode: replace | append`
- `inheritProjectContext: bool`
- `inheritSkills: bool`
- `defaultContext: fork | clean`

> Consequence: all 20+ Stellar personas (`coding_reviewer`, `claim-verifier`, `codebase-analyzer`, …) work via `hb-orchestra` without re-authoring.

### I4 — Profile composition is first-class

A profile is a saved multi-agent workflow (chain or parallel) referenced by name. File format `.pi/profiles/<name>.{json|md}`:

```yaml
---
kind: parallel        # or "chain"
agents:
  - subagent_type: reviewer-claude
    model: anthropic/claude-sonnet-4-5
  - subagent_type: reviewer-gpt
    model: openai/gpt-5.5
  - subagent_type: qa-deepseek
    model: deepseek/deepseek-v4-pro
---
# Optional shared system prompt prefix
```

Invocation: `/profile <name> "<task>"` OR `Profile(name, task, ...)` tool. Expands internally to a multi-step `agent_team` graph; same detached substrate as `Agent()`.

> Consequence: "cross-model review" is configurable from project workspace, not hardcoded.

### I5 — Reproducibility ledger is mandatory

Every delegated run writes a durable manifest:

```
<state-root>/hb-orchestra/runs/<run_id>/
  ├── manifest.json       # objective, graph, agent profile ids, tool grants,
  │                       #   model ids, cwd/worktree/isolation,
  │                       #   input artifact hashes, output artifact paths/hashes
  ├── prompt.txt          # final composed system + task prompt
  ├── harness/            # snapshot of harness files at run time
  ├── artifacts/          # mirrored step artifacts (G1 from gap analysis)
  ├── events.jsonl        # event log
  └── replay.json         # everything needed to re-run
```

Run-hash = `sha256(system_prompt + harness_files + tools + model + task + context_files)`.

`/agent replay <run_id>` replays with the same composed inputs.

> Consequence: every run is auditable + replayable. No "I don't know why it said that" anymore.

### I6 — Harness layer is OPTIONAL governance, NOT an execution monopoly

Project may define `.pi/harness/` (project) OR `.agents/harness/` (workspace) — but `hb-orchestra` does NOT install or claim authority over either path. The harness layer reads files if present, injects content into agent system-prompts, applies tool-allowlist constraints — but does not register global commands, gates, or always-on hooks.

Adopted patterns from `ultimate-pi` (reference only):
- PlanPacket-lite (optional plan-required profile)
- Mutation-scope declaration
- Artifact-readiness contracts
- Review-gate profile
- Repair-brief format
- Trace-receipt schema

Explicitly NOT adopted:
- 35 always-on extensions
- 38 always-on agents with policy gates
- 75 skills auto-loaded
- Global `.pi/harness/**` authority

> Consequence: `hb-orchestra` stays minimal in default install. Harness opts in per-project.

### I7 — Minimal hook footprint

Hooks register only for: spawn-time, terminal-time, cancel-time, retention-sweep. No `before_provider_request`, no `tool_call`-wrap, no inline policy gates by default. Governance is enforced via explicit profile config, not runtime interception.

> Consequence: lower latency, easier debugging, no hidden control flow.

### I8 — Namespace decision

```
Filesystem namespaces (no collision with ultimate-pi or pi-subagents):

  Project workspace files:
    .pi/agents/<name>.md          (compat — same as pi-subagents)
    .pi/profiles/<name>.{json|md} (new — hb-orchestra owned)
    .pi/harness/                  (optional, project-owned, hb-orchestra reads not writes)
    .agents/harness/              (alternative workspace-level harness)
  
  State / runs:
    $XDG_STATE_HOME/hb-orchestra/runs/<run_id>/
    or override via $HB_ORCHESTRA_STATE_DIR
  
  Tool surface:
    Agent, get_subagent_result, steer_subagent           (pi-subagents compat)
    Profile                                              (new)
    agent_team (catalog/start/run_status/...)            (inherited from pi-multiagent)
    
  Slash commands:
    /agent <persona> "<task>"
    /profile <name> "<task>"
    /agents (overview, scheduled jobs, etc.)
    
  Event channel:
    hb-orchestra:run-started, :step-finished, :run-completed, :run-failed, :run-canceled
```

---

## 2. Layered architecture (6 layers)

Adapted from GPT-5.5's design (audit 2026-05-28). Each layer has a single responsibility.

```
┌─────────────────────────────────────────────────────┐
│  Layer 6: Compat Surface                            │
│    Agent() / get_subagent_result / steer_subagent   │
│    /agent + /profile slash commands                 │
│    Pi tool registration + Pi widget rendering       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Layer 5: Reproducibility Ledger                    │
│    Run-hash, manifest writer, replay engine         │
│    Artifact mirror (G1), events.jsonl persistence   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Layer 4: Harness Contracts (optional)              │
│    Project rules → system prompt injection          │
│    PlanPacket-lite, mutation-scope, artifact-ready  │
│    Review-gate / repair-brief / receipt schema      │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Layer 3: Execution Runtime                         │
│    Detached DAG (from pi-multiagent agent_team)     │
│    start/run_status/step_result/message/cancel      │
│    Worktree isolation (F5, with I1/I3 fixes)        │
│    Persistent state (B1a/B1b, with I2 namespace)    │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Layer 2: Profile Engine                            │
│    Composes ResolvedAgentProfile:                   │
│      persona + model + fallbackModels + tools       │
│      + skills + context-policy + isolation          │
│      + optional harness contract                    │
│    Chain / parallel composition for profiles        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Layer 1: Agent Registry                            │
│    .pi/agents/<name>.md reader (4-layer search)     │
│    Frontmatter parser (model, fallbacks, tools...)  │
│    Persona metadata catalog                         │
│    Case-insensitive lookup, fuzzy match             │
└─────────────────────────────────────────────────────┘
```

---

## 3. Anti-patterns (7 BLIND SPOTS to avoid)

Direct from GPT-5.5's audit. Each is a hard "do NOT do this":

| # | Blind Spot | Mitigation |
|---|------------|-----------|
| 1 | **Detached-only vision** (Tiziano's blind spot) | I1 — detached is mechanism, not API ceiling. Foreground wrappers exist. |
| 2 | **No persona/profile compat** | I3 + I4 — `.pi/agents/` + `.pi/profiles/` first-class. |
| 3 | **No tool-surface parity** | I2 — `Agent()` accepts pi-subagents-compatible params. |
| 4 | **Namespace collision** with `ultimate-pi`'s `.pi/harness/**` | I8 — strict namespace decisions. `.pi/harness/` is READ-only (if user opts in), never written by package. |
| 5 | **Hook explosion** | I7 — minimal hook footprint, governance via profiles not hooks. |
| 6 | **Research/coding conflation** (Feynman as review-gate) | Feynman is optional research provider, NOT review authority. OpenSrc + ast-grep remain mandatory for code claims. |
| 7 | **No reproducibility receipt** | I5 — every run writes hashable manifest. Replayable. |

---

## 4. Relationship to neighboring packages

| Package | Status in hb-orchestra |
|---------|-----------------------|
| `pi-multiagent` (upstream by Tiziano) | Forked. We track useful upstream changes selectively; our roadmap is independent. |
| `pi-subagents` 0.24.2 (nicobailon) | Compatibility target. Once `hb-orchestra` v0.5 ships replacement-ready, can be uninstalled. |
| `@tintinweb/pi-subagents` 0.7.3 | Compatibility reference (parallel/chain DSL, schedule, Agent() shape). Patterns adapted, not code. |
| `taskplane` 0.30.1 | Reference for orchestrator-pattern + cross-model review. Not a dependency. Future v2 may converge. |
| `ultimate-pi` 0.22.1 | Reference for harness contracts. **Patterns adapted, NOT installed as authority.** |
| `@companion-ai/feynman` 0.2.16 | Optional research profile. Selectively invoked. NOT a review gate. |
| `pi-intercom` 0.6.0 | Session-coordination — keep installed. `hb-orchestra` does not integrate intercom into agent-runtime (privacy/trust). |
| `pi-lens`, `pi-hermes-memory`, `pi-agent-browser-native`, `pi-web-access` | Unrelated, keep as-is. |
| `Pi-Unified-Swarm` (~/.pi/agent/extensions/) | Separate question (Composio/Email/Slack/Image/Video integrations). Out of scope for hb-orchestra v0.5. |
| `@runfusion/fusion` 0.31.0 | Task board — unrelated. Keep. |

---

## 5. Out of scope for v0.5

These are deliberately deferred to v1 / v2:

- **Web dashboard** (taskplane-style live monitoring) — v2
- **Cross-extension RPC** (subagents:rpc:spawn/:stop) — v1
- **Conversation viewer overlay** — v1
- **Supervisor/worker/reviewer/merger orchestrator pattern** (taskplane-niveau) — v2
- **Monorepo/polyrepo task DAG** — v2
- **Auto-fallback model on provider failure** (active resolution at run time) — v0.7 patch
- **Schedule/cron triggers** in production (lokal aktiv aus pi-multiagent NEU-C) — keeps existing surface, no new work

---

## 6. Versioning roadmap

```
v0.5 — Foundation (current target)
  - Fork + rename (hb-orchestra)
  - Layer 1-6 implemented as specified above
  - All Stellar personas verified working via Agent() + /agent
  - Profile composition functional
  - Reproducibility ledger writing manifests
  - Harness reader (read-only, opt-in)
  - pi-subagents + taskplane uninstalled cleanly
  
v0.7 — Polish
  - Auto-fallback model resolution
  - pi.events lifecycle events
  - Cross-extension RPC compat
  - Conversation viewer overlay (terminal)
  
v1.0 — Public
  - Stable API contracts
  - Published to pi.dev as hb-orchestra
  - Migration guide from pi-subagents
  - README + cookbook + 20+ examples
  
v2.0 — Orchestrator parity
  - Supervisor/worker/reviewer/merger pattern (taskplane-niveau)
  - Web dashboard
  - Monorepo/polyrepo support
  - Batch task DAG
```

---

## 7. Review gate before code

Before any code in this package changes for v0.5 implementation:

1. ✅ This ARCHITECTURE.md exists and is reviewed
2. ✅ Mark approved invariants I1-I8 on 2026-05-28
3. ✅ GPT-5.5 review completed on 2026-05-28; corrections captured in the hb-orchestra documentation audit
4. ➖ Optional: claude-sonnet-4-6 second-opinion remains available but is not a v0.5 blocker

Implementation may proceed in roadmap order. Keep I1/I2/I6/I8 as hard constraints: agent execution remains detached/non-blocking, pi-subagents-compatible callers keep working until old references are removable after parity smoke, harness paths are read-only, and namespace boundaries stay explicit.
