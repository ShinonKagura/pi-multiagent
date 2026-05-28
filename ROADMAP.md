# hb-orchestra Roadmap

## v0.5 — Foundation (current target, est. 4-5 days from 2026-05-28)

| Phase | Layer | Status | Notes |
|-------|-------|--------|-------|
| PRE-7 | — | ✅ DONE | ARCHITECTURE.md with 8 invariants + 6-layer model + 7 anti-patterns |
| 7.0 | — | ✅ IN PROGRESS | Fork + rename `pi-multiagent` → `hb-orchestra`, branch + package.json + README |
| 7.1 | L1 agent-registry | ⏳ SKELETON | `.pi/agents/<name>.md` reader (frontmatter + body parse). v0.5 smoke-test green: loads `stellar/.pi/agents/coding_reviewer.md` with all 14 frontmatter fields including `model + fallbackModels + tools + extensions + inheritProjectContext + systemPromptMode`. Pending: list-all, fuzzy match. |
| 7.2 | L2 profile-engine | ⏳ NEXT | Compose ResolvedAgentProfile from persona + model + tools + skills + context-policy. Chain/parallel composition for `.pi/profiles/`. |
| 7.3 | L3 execution-runtime | ⏳ | Wire L1+L2 to `agent_team` graph runtime (inherited from pi-multiagent). |
| 7.4 | L4 harness-contracts | ⏳ | Optional `.pi/harness/` / `.agents/harness/` reader. PlanPacket-lite, mutation-scope, artifact-ready, review-gate schemas. Read-only — package never writes to `.pi/harness/`. |
| 7.5 | L5 reproducibility-ledger | ⏳ | Run manifest writer, run_hash compute, artifact mirror, replay engine. |
| 7.6 | L6 compat-surface | ⏳ | `Agent()` tool + `get_subagent_result` + `steer_subagent`. `/agent` + `/profile` slash commands. |
| 7.7 | — | ⏳ | Real-Pi smoke test: all 20+ Stellar personas via `Agent()` + `/agent` + `/profile`. |
| 7.8 | — | ⏳ | Removal of `pi-subagents` + `taskplane` (only after 7.7 fully green + backup taken). |

---

## v0.7 — Polish (TBD)

- Auto-fallback model resolution (active at run-time, not just captured)
- `pi.events` lifecycle events (`hb-orchestra:run-started/completed/failed/canceled`)
- Cross-extension RPC compat (`subagents:rpc:spawn|stop|ping` reply envelopes)
- Conversation viewer overlay (terminal-rendered, no web yet)
- I2 r1-collision full fix (proper `<pid>-<runId>` namespace; v0.5 only has detection-defense)

---

## v1.0 — Public release (TBD)

- Stable API contracts (Agent surface, Profile schema, Manifest schema)
- Published to pi.dev as `hb-orchestra`
- Migration guide from `pi-subagents` (with concrete code-level mappings)
- README + cookbook + 20+ examples covering: simple Agent, multi-model parallel, chain w/ artifact handoff, schedule, worktree-isolated, persona override
- Public test matrix

---

## v2.0 — Orchestrator parity (TBD, after v1 in production)

- Supervisor / worker / reviewer / merger pattern (taskplane-niveau)
- Web dashboard (SSE-streamed live view)
- Monorepo / polyrepo task DAG support
- Batch task orchestration with checkpoint discipline
- Possibly: deprecate `taskplane` dependency in our workflows entirely

---

## Hard "NOT in roadmap" — explicit non-goals

These exist so we don't drift toward Tiziano's mistake or ultimate-pi's bloat:

- ❌ Detached-only API — always wrap with `Agent()` foreground compatibility
- ❌ Wholesale `ultimate-pi` install — patterns only, not authority
- ❌ Wholesale `Feynman` install — optional research provider only
- ❌ Always-on policy gates / hook explosion
- ❌ Project-mutating setup commands (no `init` that writes `.pi/harness/**` etc.)
- ❌ Intercom integration in agent-runtime (privacy/trust)
