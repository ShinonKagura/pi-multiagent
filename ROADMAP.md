# hb-orchestra Roadmap

## v0.5 — Foundation (current target, est. 4-5 days from 2026-05-28)

| Phase | Layer | Status | Notes |
|-------|-------|--------|-------|
| PRE-7 | — | ✅ DONE | ARCHITECTURE.md with 8 invariants + 6-layer model + 7 anti-patterns |
| 7.0 | — | ✅ IN PROGRESS | Fork + rename `pi-multiagent` → `hb-orchestra`, branch + package.json + README |
| 7.1 | L1 agent-registry | ✅ DONE + smoke coverage verified | `.pi/agents/<name>.md` reader with frontmatter + body parse, four-path catalog, case-insensitive lookup, unique fuzzy lookup, shape validation, and v0.5 smoke coverage for `stellar/.pi/agents/coding_reviewer.md` with all 14 frontmatter fields including `model + fallbackModels + tools + extensions + inheritProjectContext + systemPromptMode`. |
| 7.2 | L2 profile-engine | ✅ COMPOSITION DONE | `.pi/profiles/<name>.{json|md}` contracts, loader, case-insensitive lookup, listAllProfiles, shape validation, and pure `resolveProfile()` composition are implemented. Resolves profile agents via injected Layer-1 persona lookup and merges persona defaults with profile overrides for model, fallbackModels, tools, thinking, context, skills, max_turns, and shared system prompt. |
| 7.3 | L3 execution-runtime | ✅ GRAPH MAPPING DONE | Pure `profileToDetachedGraphStart()` maps resolved profiles to schema-valid detached `agent_team` start graphs with chain/parallel dependencies, inferred authority, model/thinking lane preservation, and mutation-scope validation. Tool/slash-command registration remains L6. |
| 7.4 | L4 harness-contracts | ⏳ | Optional `.pi/harness/` / `.agents/harness/` reader. PlanPacket-lite, mutation-scope, artifact-ready, review-gate schemas. Read-only — package never writes to `.pi/harness/`. |
| 7.5 | L5 reproducibility-ledger | ⏳ | Run manifest writer, run_hash compute, artifact mirror, replay engine. |
| 7.6 | L6 compat-surface | ✅ DONE (v0.5) | Full compat surface wired + tested: `Agent` tool + `/agent`, `Profile` tool + `/profile` (persona/profile → L1/L2/L3 → detached `agent_team` start, returns runId), `get_subagent_result` (→ run_status), `steer_subagent` (→ message with auto live-step resolution), and bounded foreground `waitSeconds` on Agent/Profile (capped 600s, returns runId on timeout per I1). Real-Pi smoke is 7.7. |
| 7.7 | — | 🟡 L6-minimal PASS | Real-Pi **interactive** smoke green: Load + `/agent` + `Agent` tool (incl. tools-override) + `run_status`/`cancel`, real `coding_reviewer` review. Optional breadth across remaining personas: `docs/7.7-breadth-checklist.md`. `/profile` + `Profile()` are now command/tool-wired (real-Pi probe green: 2-step parallel profile → runId). foreground-wait/get/steer remain pending. |
| 7.8 | — | 🟢 pi-subagents done · 🔵 taskplane deferred | **Re-scoped 2026-05-29** (see `docs/7.8-rescope.md`). `pi-subagents`+`pi-multiagent` (npm) removal is **done + validated** (already absent from global config; personas use the openswarm bundle; fork provides `Agent`/`agent_team`; backups under `~/.pi/agent/maintenance/pi-7.8-prep/`). `taskplane` removal is **deferred to fork v2** — the fork does not replace its supervisor/worker/merger; removing it now breaks 4 personas + 2 skills. openswarm-bundled `pi-subagents` is a separate migration track. |

---

## v0.7 — Polish (TBD)

- Auto-fallback model resolution (active at run-time, not just captured)
- `pi.events` lifecycle events (`hb-orchestra:run-started/completed/failed/canceled`)
- Cross-extension RPC compat (`subagents:rpc:spawn|stop|ping` reply envelopes)
- Conversation viewer overlay (terminal-rendered, no web yet)
- I2 r1-collision: common case FIXED (runId serial seeded past the highest persisted run dir so a fresh process never reuses an orphan's id; sequential processes verified r1->r2). Optional remaining hardening: a full `<pid>-<runId>` namespace for truly concurrent same-machine processes.

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
