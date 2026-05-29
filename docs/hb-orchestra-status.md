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
| L4 harness-contracts | read-only contract reader: `.pi/harness/contract.json` (project) / `.agents/harness/contract.json` (workspace) governance subset — mutation scope/paths, approval/review gates, artifact-ready, system-prompt files, plan-packet pointer — + `/harness` command. Reads, never writes (I6). | ✅ | `extensions/orchestra/src/harness-contracts/*`, `index.ts` (`/harness`), `examples/harness/contract.json` | `tests/orchestra-harness-contracts.test.ts` (7) + load probe |
| L4 harness-contracts | enforce on `Agent`/`Profile` runs: inject `systemPromptFiles` into step prompts + block mutating runs when `mutationAllowed:false` (applied at build time so replay re-runs the baked graph; harness influence folds into run_hash via injected prompts) | ✅ | `extensions/orchestra/src/harness-contracts/apply.ts`, `index.ts` (start helpers) | `tests/orchestra-harness-apply.test.ts` (6) + real-Pi probe (block + allow) |
| L4 harness-contracts | path-allowlist / forbidden-path enforcement (tool-broker depth) + parse the full nested-YAML PlanPacket | ⏳ | — | — |
| L5 reproducibility-ledger | deterministic `run_hash` over composed inputs (canonical JSON) + `buildReplayManifest`; emitted as a `hb-orchestra:run-hash` event and appended to `Agent`/`Profile` start results | ✅ | `extensions/orchestra/src/reproducibility-ledger/*`, `index.ts` (start path) | `tests/orchestra-reproducibility-ledger.test.ts` (7) |
| L5 reproducibility-ledger | persisted replay ledger + re-execution: writes `<run_hash>.json` to hb-orchestra's own state dir (keyed by stable run_hash + runId index; NOT the substrate `runs/` dir, avoiding OPEN-2 collisions) and a `Replay` tool + `/replay <run_hash\|runId>` re-launch. Verified: replay's run_hash == original. | ✅ | `extensions/orchestra/src/reproducibility-ledger/ledger-store.ts`, `index.ts` (`startReplay`) | `tests/orchestra-replay-ledger.test.ts` (5) + real-Pi probe |
| L5 reproducibility-ledger | (run manifest, events.jsonl, artifact mirror are already substrate-persisted; literal ARCHITECTURE used `replay.json` in the run dir + `/agent replay` — hb-orchestra keys by run_hash in its own dir and uses `/replay` instead) | note | — | — |
| L6 compat-surface | `Agent` tool + `/agent <persona> <task>` command: persona → single-step detached graph → `agent_team` start (detached, returns runId) | 🟡 | `extensions/orchestra/src/compat-surface/{agent-graph,types,index}.ts`, `extensions/orchestra/index.ts` | `tests/orchestra-compat-surface.test.ts` (6) + load probe |
| L6 compat-surface | `Profile` tool + `/profile <profile> <task>`: profile (L2) + member personas (L1) → detached chain/parallel graph (L3) → `agent_team` start (returns runId) | ✅ | `extensions/orchestra/index.ts` (`startProfileRun`) | `tests/orchestra-profile-command.test.ts` (3) + real-Pi probe |
| L6 compat-surface | `get_subagent_result` / `steer_subagent`: pi-subagents-compatible wrappers over `agent_team` run_status / message (auto-resolves the live step) | ✅ | `extensions/orchestra/index.ts` (`getSubagentResult`/`steerSubagent`/`resolveSteerStepId`) | `tests/orchestra-steer-step.test.ts` (4) + real-Pi probe |
| L6 compat-surface | bounded foreground wait: `waitSeconds` on `Agent`/`Profile` (capped 600s; returns the terminal result inline, still returns the runId on timeout per I1) | ✅ | `extensions/orchestra/index.ts` (`startRunMaybeWait`/`clampForegroundWaitSeconds`) | `tests/orchestra-foreground-wait.test.ts` (4) + real-Pi probe |

**Inherited & working today** (from `pi-multiagent` v0.10.0 substrate, unchanged): detached `agent_team` DAG runtime (`start`/`run_status`/`step_result`/`message`/`cancel`/`cleanup`), worktree isolation (F5 + local I1/I3 fixes), persistent run state + reattach (B1a/B1b), scheduling (NEU-C), artifact mirroring (G1), retention sweep (G3), `pi.events` lifecycle (G4).

---

## What "🟡 L6 minimal" means in practice

Implemented now:
- `Agent({ subagent_type, prompt, ... })` tool — model-callable.
- `/agent <persona> <task>` — operator command.
- Both resolve a persona by name (model + thinking + tools + system prompt), build a single inline-step detached graph, and start it on the inherited substrate. The call returns immediately with a run receipt + `runId`.

Foreground wait:
- By default the call is **detached** and returns a `runId` immediately. Pass `waitSeconds` (1–600) on `Agent`/`Profile` to **block until the run finishes and get the result inline**; on timeout it still returns the `runId` to inspect with `get_subagent_result` (ARCHITECTURE I1: the wait is bounded and never traps the parent).

(`Profile()` + `/profile` are now wired: L2 `resolveProfile` + L1 personas → L3 `profileToDetachedGraphStart` → `agent_team` start. Inspect the returned `runId` like any `Agent` run.)

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
  cannot read a flag registered by the multiagent extension. Fixed by hard-defaulting the compat
  surface to `disabled` (pi-subagents semantics: children do not inherit caller skills). **Known
  limitation:** the operator `--agent-team-subagent-skills` flag does NOT affect `/agent` yet — only
  `disabled` short-circuits the cap, while `auto`/`enabled` both hard-error over the cap in the
  `resolveDetachedGraph` path (no auto soft-fallback there). Honoring the operator flag needs orchestra
  to register the flag itself (tracked follow-up), so it is intentionally deferred for v0.5-minimal.
- **OPEN-1 — `agent_team run_status` now finds orchestra-started runs.** `detached-registry.ts`
  held a module-local `Map`; loading orchestra + multiagent as two `-e` extensions created two
  module instances → split-brain registry (orchestra registered runs that `run_status` /
  `step_result` / `message` / `cancel` could not find; `list` still worked because it also reads
  persistent disk state). Fixed by anchoring the Map on `globalThis` (true per-process singleton),
  which repairs all five actions at once. Verified: `Agent` start → `run_status <runId>` resolves
  and tracks to `terminal=true`.

Still open:
- **OPEN-2 (FIXED 2026-05-29 for the common case)** — per-process runId serials (`r1,r2,...`) used to
  restart at r1 each process and collide with an orphaned r1 still on disk (createPersistentRun refused
  the foreign-pid dir → run failed). The serial is now lazily seeded past the highest persisted run dir
  (`seedRunIdSerialFromDisk` / `highestPersistedRunIdSerial` in `delegation.ts`), so a fresh process
  allocates above all orphans. Verified: two sequential processes -> r1 then r2, no collision. Residual
  edge: truly concurrent same-machine processes can still race the same seed (the createPersistentRun
  foreign-pid guard catches it); a full `<pid>`-namespaced id remains an optional v0.7 hardening.
- **Project-agent personas (still open)** (e.g. project `.pi/agents/coding_reviewer.md`) require interactive UI
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
- Roadmap gate 7.7 (Real-Pi smoke across 20+ Stellar personas via `Agent()` + `/agent`): **L6-minimal PASS (interactive)** — operator TTY run proved Load + `/agent` + `Agent` tool (incl. tools-override) + project-agent confirm + `run_status`/wait + child `succeeded` with a real review artifact (`coding_reviewer` on `phase8_receipt_verifier.rs`). See `docs/7.7-real-pi-smoke-receipt.md`. Remaining (optional breadth): repeat across the other 20+ personas before 7.8.
- Roadmap gate 7.8 — **re-scoped 2026-05-29** (`docs/7.8-rescope.md`): `pi-subagents`+`pi-multiagent` (npm) removal is **done + validated** (already absent from the global config; personas use the openswarm bundle; the fork provides `Agent`/`agent_team`; backups under `~/.pi/agent/maintenance/pi-7.8-prep/`). `taskplane` removal is **deferred to fork v2** — the fork does not replace its supervisor/worker/merger (removing it breaks 4 personas + 2 skills). openswarm-bundled `pi-subagents` is a separate track. Consumer map: `~/.pi/agent/maintenance/pi-7.8-prep/7.8-CONSUMER-MAP-AND-PLAN.md`.

## L6 usage notes (operator)

Confirmed during the 7.7 interactive smoke; these are correct behaviors, not bugs:

1. **bash-capable personas via `Agent()` / `/agent`.** A persona that declares `bash` in its `tools`
   makes the mapper derive `allowShellTools`, and the substrate fail-closes a shell-capable child whose
   cwd contains a project-controlled `.pi/settings.json` (`bash-project-settings-denied` — a HARD_RULES
   trust-boundary). To run such a persona you must either (a) drop bash via the `Agent` tool
   `tools:["read","grep","find","ls"]` override (the `/agent` slash command cannot pass a tools
   override), (b) grant explicit project-code trust, or (c) use a cwd without project `.pi/settings.json`.
2. **Model resolution for breadth tests.** A persona with no frontmatter `model` falls back to the
   session default model; if that default is not resolvable in the child it 404s (e.g. `reviewer` fell
   back to an unavailable `claude-3-5-haiku-latest`). When sweeping 20+ personas, either pin each
   persona's frontmatter `model` or launch with a `--model` whose provider/model resolves in the child,
   to avoid r1-style 404s that look like failures but are only model resolution. (Active
   `fallbackModels` resolution is a v0.7 item; today fallbacks are captured-only.)
3. **Launch:** use Option C (disable the conflicting `npm:pi-multiagent` + `@tintinweb/pi-subagents`,
   then run pi normally with the fork via `-e`). `--no-extensions` breaks interactive startup.
