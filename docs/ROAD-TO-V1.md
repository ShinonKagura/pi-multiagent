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
  - [ ] **Pay down inherited multiagent test debt** — 7 files still red under node+loader, all
    pre-existing substrate issues (NOT the orchestra layer):
    - stale expectations (mechanical): `authority-policy` (expects 4 authority keys; source has 6 —
      `allowProjectCode`, `allowMutationWorktree`), `result-format` (healthy-run wording drifted).
    - need a design decision (do not guess): `rendering` (source uses `ctx.ui.setStatus`; test
      forbids the shared footer row), `examples` (`worktree-isolated-mutation.json` is
      mutation-capable but the test asserts no packaged example may be).
    - inspect: `delegation`, `planning` (assertion drift — stale vs behavioral TBD).
    - slow/hang: `worktree-isolation-persistence-interlock` (quarantined from CI via per-test
      timeout + exclusion).
  - [ ] Document the canonical test command(s) in the README once the substrate suite is green.
- **D2 [BLOCKER]** CI pipeline. _Done (first iteration) 2026-05-29:_ `.github/workflows/ci.yml` runs
  on push/PR to `hb-orchestra-v0.5`/`main`: `pnpm install --frozen-lockfile` + `pnpm run typecheck`
  (required) + the hb-orchestra-layer tests via node+loader (required gate) + the inherited substrate
  suite (informational, `continue-on-error`, timeout-guarded). Green/red shows on GitHub on next push;
  follow-ups: tighten the informational step into a required gate once the debt above is paid, and
  add the `check:*` release scripts.

## Block A — Functional completeness (finish the layers)

- [ ] **A1 [BLOCKER]** L4 path-allowlist / forbidden-path **enforcement** at tool-broker depth
  (currently read into the contract but not enforced). Mutation gate + prompt injection already land.
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
