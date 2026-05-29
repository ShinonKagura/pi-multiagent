# hb-orchestra — Feature Status Matrix

**Doc class:** implementation status (single source of truth for "what exists vs planned").
**Version:** v0.5.0-pre
**Last updated:** 2026-05-29
**Verification runner:** `bun test` (the package's `node --test` script is currently blocked in some dev environments by a broken global `typebox/build/compile` install; bun resolves it correctly and is the authoritative local signal until that is fixed).

This file closes audit gap **D3** ("no single feature status matrix ties docs → code → tests"). It is the canonical answer to "is feature X implemented?". `README.md` / `HB_ORCHESTRA_README.md` describe intent; `ARCHITECTURE.md` locks design; this file states reality.

Legend: ✅ implemented + tested · 🟡 partial · ⏳ not started · ➖ deferred (v0.7+).

---

## Layer status

| Layer | Feature | Status | Code | Test |
|-------|---------|--------|------|------|
| L1 agent-registry | `.pi/agents/<name>.md` reader, 4-path catalog, listAll, case-insensitive + unique-fuzzy lookup, frontmatter shape validation, project-shadow precedence | ✅ | `extensions/orchestra/src/agent-registry/{persona-loader,types,index}.ts` | `tests/orchestra-agent-registry.test.ts` (12) |
| L2 profile-engine | `.pi/profiles/<name>.{json\|md}` loader + validator + markdown-frontmatter subset parser; pure `resolveProfile()` (persona defaults merged with profile overrides; shared system prompt) | ✅ | `extensions/orchestra/src/profile-engine/{profile-loader,profile-composer,types,index}.ts` | `tests/orchestra-profile-engine.test.ts` (9) |
| L3 execution-runtime | pure `profileToDetachedGraphStart()` → schema-valid + `resolveDetachedGraph`-plannable detached graph (chain/parallel deps, inferred authority, model/thinking lanes, mutation-scope gate) | ✅ | `extensions/orchestra/src/execution-runtime/{profile-graph,types,index}.ts` | `tests/orchestra-execution-runtime.test.ts` (6) |
| substrate | per-step `model` / `thinking` lane overrides on inline/library `agent_team` steps (enables L3 lane preservation) | ✅ | `extensions/multiagent/src/{schemas,types,planning}.ts` | `tests/schemas.test.ts`, `tests/preflight-schema-drift.test.ts` |
| L4 harness-contracts | read-only `.pi/harness/` / `.agents/harness/` reader (PlanPacket-lite, mutation-scope, artifact-ready, review-gate) | ⏳ | — | — |
| L5 reproducibility-ledger | run manifest writer, `run_hash`, artifact mirror, replay engine | ⏳ | — | — |
| L6 compat-surface | `Agent` tool + `/agent <persona> <task>` command: persona → single-step detached graph → `agent_team` start (detached, returns runId) | 🟡 | `extensions/orchestra/src/compat-surface/{agent-graph,types,index}.ts`, `extensions/orchestra/index.ts` | `tests/orchestra-compat-surface.test.ts` (6) + load probe |
| L6 compat-surface | foreground inline-result wait, `get_subagent_result`, `steer_subagent`, `Profile()` + `/profile` | ⏳ | — | — |

**Inherited & working today** (from `pi-multiagent` v0.10.0 substrate, unchanged): detached `agent_team` DAG runtime (`start`/`run_status`/`step_result`/`message`/`cancel`/`cleanup`), worktree isolation (F5 + local I1/I3 fixes), persistent run state + reattach (B1a/B1b), scheduling (NEU-C), artifact mirroring (G1), retention sweep (G3), `pi.events` lifecycle (G4).

---

## What "🟡 L6 minimal" means in practice

Implemented now:
- `Agent({ subagent_type, prompt, ... })` tool — model-callable.
- `/agent <persona> <task>` — operator command.
- Both resolve a persona by name (model + thinking + tools + system prompt), build a single inline-step detached graph, and start it on the inherited substrate. The call returns immediately with a run receipt + `runId`.

Not yet:
- The call does **not** block and return the child's final answer inline (foreground wait). Inspect results with `agent_team run_status` / `step_result` using the returned `runId`.
- No `get_subagent_result` / `steer_subagent` convenience wrappers yet (use `agent_team`).
- No `Profile()` / `/profile` yet (L2/L3 logic exists and is tested, but is not wired to a tool/command).

---

## Verification

```bash
# Authoritative local signal (bun resolves typebox correctly):
bun test tests/orchestra-agent-registry.test.ts \
         tests/orchestra-profile-engine.test.ts \
         tests/orchestra-execution-runtime.test.ts \
         tests/orchestra-compat-surface.test.ts
# => 33 pass, 0 fail
```

Known environmental caveats (pre-existing, not hb-orchestra regressions):
- `pnpm run typecheck` reports errors in the inherited `multiagent` extension + the peer-dep `@earendil-works/pi-coding-agent` (version skew: `LibraryOptions.projectAgents`, `PiContext` export, `allowProjectCode`). hb-orchestra Layer code adds **zero** new typecheck errors.
- `pnpm test` (`node --test`) currently fails to load schema modules due to a missing `typebox/build/compile/index.mjs` in the global install; and the heavy `delegation`/`child-launch` suites spawn real child Pi processes (long-running). Use scoped `bun test` for the orchestra layers.
- `tests/planning.test.ts` has 2 pre-existing failures (`package:validator` shell / `package:worker` mutation capability) on pure HEAD — same version-skew root cause, unrelated to orchestra layers.

---

## Gate state

- Architecture gate (ARCHITECTURE §7): **closed** — Mark approved I1–I8 (2026-05-28); GPT-5.5 review captured in the Stellar hb-orchestra documentation audit. Optional external second-opinion is not a blocker.
- Roadmap gate 7.7 (Real-Pi smoke across 20+ Stellar personas via `Agent()` + `/agent`): **open** — operator-run; required before 7.8.
- Roadmap gate 7.8 (remove `pi-subagents` + `taskplane`): **blocked** until 7.7 is fully green and a backup exists.
