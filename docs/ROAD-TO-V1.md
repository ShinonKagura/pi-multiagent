# Road to hb-orchestra v1.0

Working plan from the v0.5 milestone to a public, daily-workflow-ready v1.0. Grounded in `ROADMAP.md`
(v0.7 + v1.0) and the live `docs/hb-orchestra-status.md`. Items are tagged **[BLOCKER]** (hard v1.0
gate) or **[opt]** (polish / can ship after). Check items off as they land.

Recommended order: **D (CI/test health) → A1 + B1 + B3 (functional/robust) → C (release engineering)**.

---

## Block D — Test / CI health (do first; everything else needs a green, verifiable baseline)

- **D1 [BLOCKER]** Restore a clean test runner. _Progress 2026-05-29:_
  - [x] **`tsc --noEmit` is now GREEN (was 9 errors).** All 9 were inherited `multiagent` drift where
    the impl used newer fields/signatures the type decls/exports hadn't caught up to: aligned
    `normalizeLibraryOptions`/`discoverAgents` to the required `projectAgents` field, added
    `allowProjectCode` to the caller-skills input, `extensionToolPolicy`/`cwd` to
    `ToolResolutionContext`, an optional cwd arg to `catalogParentExtensionTools`, re-exported
    `MutationWorktreeState`, and **implemented the missing `formatAgentTeamLiveStatus`** (a real
    latent runtime bug — it was called by the live-run widget but defined nowhere).
  - [x] Confirmed the orchestra layer is unaffected: `bun test tests/orchestra-*.test.ts` 73/73.
  - [x] **node+loader runner FIXED.** The `tests/pi-peer-loader.mjs` hardcoded typebox/pi-tui as
    NESTED under the peer root, which only holds for a flat global npm install; a clean pnpm/CI
    install HOISTS them to the top level, so node died with `typebox/build/compile ENOENT`. The
    loader now resolves each peer specifier via Node resolution from the fork root first (pnpm/CI),
    then the legacy nested path (flat global). Result: **node+loader suite 25/45 → 38/45 green**, and
    all 12 `orchestra-*` files pass.
  - **Pay down inherited multiagent test debt** — was 7 files red; all pre-existing substrate issues
    (NOT the orchestra layer). _Progress 2026-05-29:_
    - [x] `authority-policy` — refreshed: `GRAPH_AUTHORITY_KEYS` + fixtures now include the two real
      keys the source ships (`allowProjectCode`, `allowMutationWorktree`). 3/3.
    - [x] `result-format` — refreshed: `Next:`/cleanup/cursor/diagnostic wording aligned to current
      model-facing strings; project-catalog assertion flipped to a positive `allowProjectCode` check.
      23/23.
    - [x] `delegation` + `planning` — rewritten to the **v0.10 capability redesign**: library default
      tools are CAPPED to granted authority with a `catalog-default-tools-capped` warning (no more
      hard `validator-shell` / `worker-mutation` rejection), and mutating steps require an explicit
      `mutationScope` (`mutation-scope-required`). Each scenario was verified against the live
      resolver. planning 25/25, delegation 79/79.
    - [x] `rendering` — removed the vestigial `ctx.ui.setStatus` footer path + `formatAgentTeamLiveStatus`
      (the test declares the formatter "should stay removed"; widget+notices are the surface). 22/22.
    - [x] `examples` — `worktree-isolated-mutation.json` is treated as the one deliberate copy/adapt
      mutation TEMPLATE: exempt from the no-mutation rule (with an isolation-safety assertion) and
      from the runnable-resolve coverage (its placeholder mutationScope is denied until replaced). 5/5.
    - [x] `rpc-child-controller-unref` + `worktree-isolation-persistence-interlock` — the real-pi
      coupling is gone: a shared `tests/fake-rpc-child.ts` provides `FakeRpcChild` + `fakeSpawn`, and
      `getPiInvocation` now honors a trust-checked `PI_MULTIAGENT_PI_LAUNCHER` override so a clean
      runner without pi on PATH resolves a (never-executed) launcher. The worktree hang was a fragile
      `/proc/1` "unwritable path" that BLOCKED in sandboxed runners; switched to `/dev/null/...` which
      fails fast (ENOTDIR) everywhere.
  - **Suite status: 45/45 test files / 287 substrate tests green** under node+loader (orchestra layer
    73/73 on top). CI gate 3 (full inherited substrate) is now a **required** green gate. All three
    CI gates (typecheck + hb-orchestra layer + inherited substrate) are required and env-independent.
  - [ ] Document the canonical test command(s) in the README once the substrate suite is green.
- **D2 [BLOCKER]** CI pipeline. _Done (first iteration) 2026-05-29:_ `.github/workflows/ci.yml` runs
  on push/PR to `hb-orchestra-v0.5`/`main`: `pnpm install --no-frozen-lockfile` (repo gitignores
  lockfiles; `strictDepBuilds:false` in `pnpm-workspace.yaml` for the pnpm-11 build gate) +
  `pnpm run typecheck` (required) + the hb-orchestra-layer tests via node+loader (required gate) +
  the inherited substrate suite (informational, `continue-on-error`, timeout-guarded). **Confirmed
  GREEN on GitHub Actions** (run 26655159894: install + typecheck + hb-orchestra layer 73/73 all ✓;
  informational substrate step non-blocking). Follow-ups: tighten the informational step into a
  required gate once the debt above is paid, add the `check:*` release scripts, and bump the actions
  off the deprecated Node 20 runtime (warning only).

## Block A — Functional completeness (finish the layers)

- [x] **A1** L4 path/scope governance **enforcement** landed: a planning-time forbidden-path gate
  (blocks a mutating step whose declared `mutationScope` targets a contract `forbiddenPath`,
  `harness-policy-denied`) + governance injection (allowedPaths/forbiddenPaths/mutationScope/
  externalSideEffects appended to child prompts). Verified by 12 unit tests + a real-Pi block/allow
  probe. Honest scope: planning + prompt tier, NOT an OS path sandbox — hard mutation confinement
  remains worktree isolation's job (a deeper tool-broker sandbox is a possible later increment).
- [ ] **A2 [opt]** Parse the full nested-YAML PlanPacket (Lite/pointer form is enough for the v1.0
  core).

## Block B — v0.7 robustness / polish (mostly pre-v1.0)

- [x] **B1** Runtime fallback-model resolution landed: `fallbackModels` now flows persona/profile ->
  graph step (schema + GraphStepAgentInput) -> ResolvedAgent, and the DetachedRun step executor
  retries the step on the next fallback model when the primary fails with a retryable model/provider
  error (`modelCandidates` + `isRetryableModelError` in `detached-run.ts`, emitting a `model-fallback`
  event). Verified: 4 unit tests + an e2e (primary lane model-error -> fallback lane succeeds) + 292
  substrate tests green, no regression. Honest scope: the retry trigger is a heuristic match on the
  failure message (broad by design — a false positive costs only one extra attempt, never a wrong
  success); there is no pre-flight availability probe (no available-models API).
- [x] **B2** `pi.events` lifecycle events: the existing run lifecycle emits (run-started, run-completed,
  step-finished, run-failed-pre-start) are now **dual-branded** — every `pi-multiagent:` event is also
  mirrored under `hb-orchestra:`, plus a status-specific terminal event
  (`run-succeeded|run-failed|run-canceled|run-timed_out`) so a consumer can subscribe to one outcome.
  `detached-run.ts` (`emitLifecycle` dual-prefix + terminal emit); tested in `tests/lifecycle-events.test.ts`.
- [x] **B3** Cross-extension RPC surface landed: `registerSubagentsRpc` (extensions/multiagent/src/
  rpc-bridge.ts) listens on the shared Pi `EventBus` for `subagents:rpc:ping|spawn|stop` and answers
  each with a reply envelope on `subagents:rpc:reply` (`{ id?, method, ok, result?|error? }`). Wired in
  index.ts: ping -> liveness+version, spawn -> `runAgentTeam` start (result `{ runId }`), stop ->
  `getDetachedRun(runId).cancel()`. Tested with a real EventBus (7 cases: ping/stop/spawn success +
  error + unsubscribe + parsing). Honest scope: there is no surviving pi-subagents protocol spec to
  mirror byte-for-byte, so this DEFINES hb-orchestra's cross-extension contract; RPC-spawned runs use a
  synthetic `subagents-rpc` session id and are not auto-cancelled on user session shutdown.
  (Separately, the legacy `tests/check-package-load.ts` script is pre-existing-red: it was written for
  the single-extension package and asserts `agent_team` per extension + has an incomplete mock for
  the orchestra extension's `registerCommand`; not in the CI gates, tracked for a later rewrite.)
- [ ] **B4 [opt]** OPEN-2 concurrency edge: a `<pid>`-namespaced runId for truly concurrent
  same-machine processes (the common sequential case is already fixed via serial seeding).
- [ ] **B5 [opt]** OPEN-3: `bash` persona from a project-settings workspace + headless project-agent
  confirmation friction.
- [ ] **B6 [opt]** Terminal conversation-viewer overlay.

## Block C — v1.0 release engineering (the explicit v1.0 contract)

- [x] **C1** Public API frozen: `docs/API.md` documents the v1.0 semver contract (tools, slash
  commands, persona/profile/harness schemas, graph authority keys, run_hash + replay manifest,
  lifecycle events, cross-extension RPC). A machine-checked subset is guarded by
  `tests/orchestra-api-contract.test.ts` (run_hash determinism, replay manifest field set +
  schemaVersion, RPC channels, harness discovery surface, authority key set) so an accidental breaking
  change trips CI. Linked from HB_ORCHESTRA_README.md.
- [x] **C2** Migration guide from `pi-subagents`: `docs/MIGRATION-FROM-PI-SUBAGENTS.md` with concrete
  before/after code mappings (Agent/get/steer tools + `/agent` are near drop-in; foreground ->
  `waitSeconds`; chains -> Profiles; same `.pi/agents/` personas; `subagents:rpc:*` channels; dual-
  branded lifecycle events) and the intentional non-goals (no child->parent intercom, no recursion).
  Linked from HB_ORCHESTRA_README.md. (The inherited `docs/migration-guide.md` remains the lower-level
  agent_team graph migration.)
- [x] **C3** Cookbook + examples: `docs/COOKBOOK.md` (11 recipes covering simple Agent, multi-model
  parallel, chain with artifact handoff, persona/model override, worktree-isolated mutation, schedule,
  replay, harness governance, steer, and RPC). Example assets: 5 personas (`examples/agents/`), 3
  profiles (`examples/profiles/`), 18 graphs (`examples/graphs/`), 1 harness contract = 27 runnable
  examples (>20). Personas validated through the real loader (0 errors; `fallbackModels` parses).
  Linked from HB_ORCHESTRA_README.md.
- [ ] **C4 [BLOCKER]** Publish to pi.dev as `hb-orchestra`.
- [ ] **C5 [BLOCKER]** Public test matrix (depends on D1/D2 being green).

---

## Honest framing

v0.5 → v1.0 is **not** "a couple of commits". The code core exists and is proven; the bulk of the
remaining work is A1 (deep, tool-broker), B1/B3 (robustness + migration parity), and especially
**C + D** (release engineering: API freeze, migration guide, 20+ examples, green CI, publish).

Rough estimate: A + B ≈ a few focused days; **C + D ≈ the larger chunk** (examples + CI + API freeze +
publish), realistically 1–2 weeks of clean work.

_Status of each item is mirrored in `docs/hb-orchestra-status.md`; this file is the sequenced plan._
