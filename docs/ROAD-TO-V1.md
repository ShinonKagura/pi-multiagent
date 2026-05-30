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

- [ ] **B1 [BLOCKER]** Runtime fallback-model resolution (active at run-time, not just captured) so a
  missing/limited primary model falls back instead of failing the run.
- [ ] **B2 [opt]** `pi.events` lifecycle events (`hb-orchestra:run-started/completed/failed/canceled`).
- [ ] **B3 [BLOCKER]** Cross-extension RPC compat (`subagents:rpc:spawn|stop|ping` reply envelopes) —
  required for drop-in replacement of extensions that talked to pi-subagents via RPC.
- [ ] **B4 [opt]** OPEN-2 concurrency edge: a `<pid>`-namespaced runId for truly concurrent
  same-machine processes (the common sequential case is already fixed via serial seeding).
- [ ] **B5 [opt]** OPEN-3: `bash` persona from a project-settings workspace + headless project-agent
  confirmation friction.
- [ ] **B6 [opt]** Terminal conversation-viewer overlay.

## Block C — v1.0 release engineering (the explicit v1.0 contract)

- [ ] **C1 [BLOCKER]** Freeze the public API: stable, semver'd contracts for the Agent surface, the
  Profile schema, and the Manifest schema. No breaking changes after this.
- [ ] **C2 [BLOCKER]** Migration guide from `pi-subagents` with concrete code-level mappings.
- [ ] **C3 [BLOCKER]** README + cookbook + **20+ examples**: simple Agent, multi-model parallel, chain
  with artifact handoff, schedule, worktree-isolated, persona override.
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
