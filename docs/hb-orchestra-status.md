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

## Real-Pi load fixes & remaining items (2026-05-29)

The first real-Pi (`pi --print`, v0.77.0) smoke from the Stellar workspace found that the prior
"🟡 L6 minimal" claim was not actually loadable/usable. Fixes applied (see
`docs/7.7-real-pi-smoke-receipt.md` for full evidence):

- **FIX-1 — fork now loads.** `extensions/multiagent/index.ts` imported `./src/library-policy.ts`,
  which was dropped during the fork trim (upstream deleted it in 0.9.3) and never recorded as a
  deletion, so the extension failed to load with `Cannot find module './src/library-policy.ts'`.
  Restored from history (`80bc8a8^`). bun tests never caught it because they import source modules
  directly and never load `index.ts`.
- **FIX-2 — `/agent` works in a normal skill-rich session.** orchestra's `buildRuntimeOptions`
  passed no `subagentSkills` config, so `readSubagentSkillConfig(undefined)` defaulted to `enabled`
  → all ~120 caller skills propagated → `MAX_CALLER_SKILLS` (128) tripped → child never started.
  The `--agent-team-subagent-skills` flag does not help because orchestra's separate `ExtensionAPI`
  cannot read a flag registered by the multiagent extension. Fixed by defaulting the compat surface
  to `disabled` (pi-subagents semantics) while still honoring the flag if readable.
- **OPEN-1 — `agent_team run_status` now finds orchestra-started runs.** `detached-registry.ts`
  held a module-local `Map`; loading orchestra + multiagent as two `-e` extensions created two
  module instances → split-brain registry (orchestra registered runs that `run_status` /
  `step_result` / `message` / `cancel` could not find; `list` still worked because it also reads
  persistent disk state). Fixed by anchoring the Map on `globalThis` (true per-process singleton),
  which repairs all five actions at once. Verified: `Agent` start → `run_status <runId>` resolves
  and tracks to `terminal=true`.

Still open:
- **OPEN-2 (latent)** — per-process runId namespace (`r1,r2,...`) collides across Pi processes;
  already tracked as ROADMAP v0.7 I2 (detection-defense only for now).
- **Project-agent personas** (e.g. project `.pi/agents/coding_reviewer.md`) require interactive UI
  confirmation ("Load project agents?", fail-closed library policy). Headless `--print` is denied by
  design; the interactive operator TTY run prompts and proceeds.

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
- Roadmap gate 7.7 (Real-Pi smoke across 20+ Stellar personas via `Agent()` + `/agent`): **partial** — automated headless probe is green for Load + `/agent`/`Agent` start + `run_status` inspection after FIX-1/FIX-2/OPEN-1 (package persona `reviewer`); the formal cross-persona **interactive operator TTY run** (project-agent confirmation + 20+ personas) is still required before 7.8.
- Roadmap gate 7.8 (remove `pi-subagents` + `taskplane`): **blocked** until 7.7 is fully green and a backup exists.
