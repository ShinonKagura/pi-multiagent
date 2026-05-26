# Changelog

## 0.10.0 - 2026-05-26

- **FIX-5 (HIGH, found in real-Pi smoke)** — `formatDetailsForModel` had no branches for `list`, `reattach`, scheduled-start, or schedule-cancel actions; it fell through to `formatError` and returned `agent-team-error - agent_team failed` to the model for every B1b/NEU-C call. Fixed with `formatListAction`, `formatReattachAction`, scheduled-start branch in `formatStart`, and new `formatCancel` that routes `scheduleCancel`. `shouldRenderGenericError` updated to NOT generic-error the new structured paths. Verified via bun smoke (5/5 PASS).
- Added NEU-A B1b: `list` and `reattach` tool actions on top of B1a persistence. `list` returns one summary per visible run with owner classification (`this-session` / `foreign-session` / `orphan` / `unknown`), persisted artifact path, and pending worktree count. `reattach` returns a read-only snapshot of an orphaned or terminal run (manifest, status, worktrees, mirrored artifacts); mutation actions on reattached runs are denied unless the original owner session id matches.
- Added G1 artifact mirroring: per-step final `.md` and worktree `.patch` artifacts are now copied into the persistent run dir's `artifacts/` subdir at create-time so reattach can find them after the original tmp `RunArtifactStore` is cleaned up.
- Added G3 periodic retention sweep: a `setInterval`+`unref` timer runs the same sweep callback every 6 hours so long-running parent sessions do not let terminal runs accumulate past their retention.
- Added G4 `pi.events` lifecycle event emission: `pi-multiagent:run-started`, `pi-multiagent:step-finished`, `pi-multiagent:run-completed`, `pi-multiagent:run-failed-pre-start`, `pi-multiagent:persistent-sweep-complete`. Cross-extension consumers can subscribe via `pi.events.on(...)`. Best-effort: emission failures never block the run.
- Added G6/G7 `worktreeSetup` declarative spec on graph steps: `propagateNodeModules:boolean` symlinks the invocation cwd's `node_modules/` into the worktree, and `symlinkPaths:string[]` symlinks additional relative paths (e.g. `.venv`, `.env.local`). Path traversal (`..`, absolute paths) is denied with warning. Setup is best-effort: missing sources warn but never fail the step. `worktreeSetup` without `isolation:"worktree"` emits a planning warning `worktree-setup-without-isolation`.
- Added NEU-B per-step output-truncation knobs: `steps[].outputLimit.{maxBytes,maxAssistantFinals}`. Clamps the per-step assistant output budget downward from `MAX_STEP_OUTPUT_BYTES` (4 MiB) and `MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP` (64); values above the package cap are denied at planning time. Useful for tightly-bounded low-output steps.
- Adversarial review pass (analysis-deepseek) on PRE+F5+B1a produced 4 findings, all addressed:
  - **FIX-1 (HIGH)**: detached run is now failed-closed at construction time when persistence is unavailable AND any step requests `isolation:"worktree"`. New diagnostic code `persistent-run-unavailable-with-worktree`. Previously a worktree-isolated step on a degraded-persistence run would leak guaranteed on Pi crash because no `worktrees.json` exists for the startup sweep to find. The non-worktree path still degrades gracefully with the existing `persistent-run-unavailable` diagnostic.
  - **FIX-2 (MEDIUM)**: `teardownWorktreeForStep` now accepts an optional `artifactStore`. The extension startup sweep passes no store (orphan cleanup does not need to persist a stale patch), removing the brittle `as never` cast on a fake store and eliminating the silent-crash risk if a future change adds a non-try/catch use of the artifact store.
  - **FIX-3 (MEDIUM)**: `mutateWorktrees` (private to `persistent-run-state.ts`) now carries an explicit reentrancy invariant doc-comment and a note that the current best-effort catch is a silent data-loss risk if async callers are ever added.
  - **FIX-4 (LOW)**: added `pruneOrphanWorktreeBranches` that removes `pi-multiagent/*` branches whose worktree is already gone (partial-teardown crash recovery). Wired into the extension startup sweep alongside `pruneStaleWorktrees`. `worktree-branch-exists` error message now includes a concrete `git branch -D` recovery hint.
- Added NEU-A B1a foundation for crash-resumable detached runs: per-host persistent run-state directory under `${PI_MULTIAGENT_STATE_DIR}` (or `${XDG_STATE_HOME}/pi-multiagent/runs/`, fallback `~/.local/state/pi-multiagent/runs/`, last-resort OS tmpdir). Each run owns `<runId>/{manifest.json, status.json, worktrees.json, .lock}`. The `.lock` is a PID file; sibling Pi sessions and a startup sweep classify a run as orphaned when the owner PID is dead or the lock file is missing. Extension activation now runs a best-effort sweep that prunes F5 worktrees leaked by orphaned runs (closes the F5 "worktree leaks across reload/crash" caveat) and deletes terminal runs whose `terminalRetentionSeconds` has expired. New runtime diagnostic `persistent-run-unavailable` fires when the on-disk layout cannot be created and the run continues in memory only. Tool actions `list` and `reattach` are deferred to Phase B1b.
- Added optional per-step git worktree isolation for mutation-capable detached steps (F5). New graph authority `allowMutationWorktree:boolean` plus per-step `isolation:"worktree"` opt-in; both required. When set, `agent_team` prepares a per-step git worktree from HEAD at `${TMPDIR}/pi-multiagent-wt-<random>/` on branch `pi-multiagent/<runId>/<stepId>`, runs the child with that worktree as cwd, captures `git diff --stat` and the full patch as `<stepId>-worktree.patch` terminal artifact, and tears the worktree and temp branch down on terminal status. Strict guarantee: any worktree prepare failure (not a git repo, dirty tree, branch collision, `git worktree add` failure) fails the step closed with a `worktree-*` code; there is no silent fallback to the invocation cwd. Planning rejects `isolation:"worktree"` on read-only steps (`worktree-non-mutation-denied`) and without graph authority (`worktree-authority-required`). Terminal-step-artifact rows and per-step final.md include `isolation`, `branch`, `patch`, and `diffStat`. Added `mutation-worktree.ts` helper module and `examples/graphs/worktree-isolated-mutation.json`.
- Fixed preflight/schema drift in `preflight-shape.ts`: removed `agents`, `synthesis`, `outputContract`, and `callerSkills` from `PreflightField`/`KNOWN_FIELDS`/`GRAPH_BODY_FIELDS` so that misplaced phantom fields no longer receive a misleading "move under graph" repair message; `GraphSchema` (`additionalProperties:false`) is now the canonical rejection path. `callerSkills` remains a valid agent-frontmatter runtime field — the change only removes the false graph-body classification.
- Changed subagent caller-skill propagation default to `auto`: propagate when safe and under cap, otherwise warn and launch children without caller skills; explicit `enabled` keeps strict hard-fail behavior.

## 0.9.1 - 2026-05-24

- Marked package-returned `agent_team` `ok:false` results as Pi tool-result errors through the supported `tool_result` hook, while keeping successful receipts non-error.
- Preserved child `tool_execution_end.isError` as debug-visible error-status tool activity and compact `lastActivity` without failing steps that later recover.
- Added bounded `Non-final assistant evidence` to failed/canceled/timed-out step artifacts when no successful final exists, and expanded final artifact metadata with launch-time tools, extension tools, model/thinking lane, and mutation scope.
- Added focused regression tests and public docs for error observability, recovered child tool errors, non-final artifact evidence, and detached ESC/cancel semantics.

## 0.9.0 - 2026-05-22

- Tightened `agent_team` supervision contracts: fire-and-forget child UI updates now render as suppressed non-error activity, `run_status(waitSeconds)` returns a structured wait receipt without waking on routine activity, and message/follow_up acceptance is explicit accepted-for-delivery transport proof rather than child compliance or completion proof.
- Made `package:web-researcher` fail closed during graph planning unless explicit callable `exa_search` and `exa_fetch` `extensionTools` are granted with extension authority, while keeping the role prompt's `BLOCKED` branch as defense-in-depth.
- Updated README, `/skill:pi-multiagent`, cookbook guidance, model-facing tool registration copy, public-doc/package-load checks, and focused tests for the new supervision and web-capability contracts.

## 0.8.7 - 2026-05-21

- Replaced model-facing detached-run identifiers with short process-local, session-owned `runId` handles such as `r1`, including schema validation, start output, repair copy, live widget/status scoping, same-session notice delivery, capacity-denial redaction, docs, examples, rendering expectations, and focused runtime tests; legacy `agt_...` values are now invalid inputs rather than aliases.

## 0.8.6 - 2026-05-21

- Added richer terminal artifact metadata: finalized step artifacts now include full task text, cwd, dependency edges, upstream artifact references, and stop/status hints, while `run_status` surfaces bounded task previews plus all terminal step artifacts instead of sinks only.
- Improved repair microcopy for common supervision mistakes, including `run_status` `stepId` plus `preview:true`, live `message` step-not-found recovery, multi-error schema diagnostics, dependency-cycle paths, and clearer TUI message action labels.
- Added `validation-matrix-gate.json` plus cookbook guidance for parent graph packets, artifact handoff packets, partial-evidence recovery, alternative-plan tournaments, and Web Research to Local Decision choreography.
- Tightened catalog role descriptions for local exploration, docs audits, adversarial review, completed review, command validation, and synthesis routing.
- Updated README, skill, examples, public-doc checks, and focused runtime tests around the new metadata and repair contracts while keeping source-size and package checks green.

## 0.8.5 - 2026-05-21

- Added recoverable child-RPC context-overflow handling so Pi compaction/continue can produce a later valid final without accepting stale pre-overflow output, while unrecovered overflow fails and blocks `needs` dependents.
- Exposed launch-time child model/thinking lanes in run snapshots, and clarified that children inherit parent defaults only at `start` time unless agent metadata pins a lane.
- Tightened README, skill, and cookbook guidance around child context isolation, overflow recovery, model-lane evidence, subagent skill propagation, and scoped weak-model tasks.
- Added the `--agent-team-subagent-skills enabled|disabled` product flag; it defaults to enabled/all caller-visible skills, rejects graph-controlled `agent.skills`, and reminds enabled children to use relevant available skills without broadening authority.
- Repaired live child activity status so prompt acceptance, reasoning/tool/message-update RPC activity, and tool events refresh compact run/TUI state without dumping reasoning deltas or fake progress.
- Contracted fossil-style public-doc and delegation checks toward survivor behavior, active denial, package hygiene, and trust-boundary invariants.

## 0.8.4 - 2026-05-20

- Corrected packaged graph examples so read-only steps omit redundant `agent.tools` overrides and release audit lanes use terminal `after` dependencies to preserve failed or missing proof evidence.
- Improved model-facing repair copy for misplaced top-level graph fields, extension-tool names placed in `agent.tools`, preview/debug `maxBytes` scope, and catalog extension-tool provenance grants.
- Tightened bundled catalog role descriptions and visible routing tags to fit the 12-tag catalog display budget while preserving documented role queries.
- Added cookbook task packet templates for mapper, reducer, validator, and worker outputs.

## 0.8.3 - 2026-05-20

- Fixed child Pi model/provider availability by using normal Pi extension discovery in child launches while keeping explicit `extensionTools` as the provenance-controlled callable extension-tool grant surface.
- Allowed unattended child RPC sessions to ignore fire-and-forget extension UI updates while still failing closed on blocking or unknown UI requests, so ambient extensions such as `pi-continue` can report status during child compaction without terminating the step.

## 0.8.1 - 2026-05-19

- Moved maintainer-only npm publishing choreography out of the public README and into local control-plane instructions, with explicit current-source, changelog, version, clean-commit, tag, publish, GitHub Release, and artifact-verification gates.
- Compressed the public README into a human Pi operator guide for install, trust boundaries, lifecycle, authority, examples, limits, troubleshooting, and source validation.
- Added terminal pushed-notice receipts that expose full sink artifact paths and retention expiry when available while keeping milestone notices compact.
- Added copyable cwd-scoped audit, implementation-validation, and sharded map-reduce graph examples, plus cookbook guidance for those patterns and the cookbook-only web-research/local-decision lane.

## 0.8.0 - 2026-05-19

- Replaced the public supervision contract with `run_status` for compact run snapshots and `step_result` for single-step inspection across runtime, schema, docs, examples, and tests.
- Hardened model-facing delegation guidance for package-only default catalog sources, positive catalog routing tags, artifact-first supervision, copy/adapt packets, reducer contracts, and command/mutation scope handoffs.

## 0.7.2 - 2026-05-19

- Improved detached-run diagnostics for retained-capacity failures, stalled pending steps, retained-run capacity buckets, terminal pushed notices, and compact failed-step reasons.
- Hardened child RPC handling with byte-based JSONL limits, bounded stdin backpressure sends, stdout/stderr error guards, parent-message budget checks, and listener teardown.
- Fixed cleanup result rendering so successful cleanup is receipt-only evidence deletion, denied or failed cleanup remains distinct, and plain notices never point operators back to deleted artifacts.
- Tightened planning and policy copy for mandatory filesystem-read authority, project/local extension-tool trust via `allowProjectCode:true`, and cleanup failure retention.
- Added fail-closed map-reduce, release-readiness, and release-fix graph examples, with validator steps requiring parent-copied command scope and release-foundry lanes denying version bump, commit, tag, push, publish, delete, install, deploy, and GitHub Release creation.
- Clarified graphFile copy/adapt usage, catalog query patterns, skeleton `NEEDS-SCOPE` behavior, filesystem-read non-sandbox guidance, and action `run` denial across docs, skill, cookbook, examples, and tests.
- Tightened release-prep guardrails so `pnpm run check:release` runs only from the clean release commit before tag/push, while npm publish and GitHub Release creation remain human-owned.
- Clarified that ignored local control-plane notes stay local while public-doc and package checks use shipped source, docs, tests, and examples as package truth.

## 0.7.1 - 2026-05-17

- Hardened `agent_team` usability surfaces by exposing effective child tools, reused `clientMessageId` receipts, cleanup-as-evidence-deletion copy, `follow_up` artifact-path guidance, and `mutationScope` non-sandbox warnings across runtime snapshots, model/TUI rendering, docs, examples, and tests.
- Added GitHub Release creation and verification to the standard release choreography, package skill, cookbook, public-release foundry, and public-doc checks.
- Split deterministic release validation from explicit-approval real Pi smoke guidance.

## 0.7.0 - 2026-05-17

- Replaced foreground `agent_team run` with detached lifecycle actions: `start`, compact `run_status`, `step_result`, `message`, `cancel`, and `cleanup`.
- Moved execution to an RPC-backed detached run manager with compact sink-final indexing, single-step inspection, live step messaging, cancellation, retention cleanup, and pure graph-file ingress.
- Added capped compact milestone/terminal pushed notices, a single live-only low-noise TUI card, debug-only raw events, and tmp final artifacts for every finalized step.
- Made detached background UI/final callbacks compaction-safe by avoiding retained tool-update callbacks and surfacing UI/final callback failures as compact run_status diagnostics plus debug events.
- Hardened detached RPC closeout, max-run expiry, event pagination, JSONL framing, artifact ownership/cleanup, launch-time source verification, and fail-closed planning diagnostics.
- Changed library-agent tool grants to inherit catalog `defaultTools` capped by graph authority, expanded read/discovery primitives into the full `read`/`grep`/`find`/`ls` suite, and split shell authority (`allowShellTools`) from structured mutation authority (`allowMutationTools`).
- Made filesystem read/discovery mandatory for every child step, so `agent.tools:[]` now means mandatory read-only rather than no tools, and `package:synthesizer`/`package:web-researcher` can inspect delegated artifact paths.
- Added fail-closed planning for mutation-capable steps without concrete first-class `mutationScope`, including write-capable steps and bash-capable `package:worker` steps.
- Added run_status `waitSeconds` for bounded wait/read snapshots, chronological append-only assistant-final artifacts, clearer compact live-step phase labels, and retention guidance that treats artifacts as durable handoff/context evidence rather than automatic cleanup trash.
- Kept `step_result` step-not-found output compact, made run_status/step_result assistant text opt-in with `preview:false` by default, added run_status hints for non-sink terminal evidence, and strengthened child prompts to require self-contained final answers.
- Added schema-valid all-inline starter guidance so parents can hand-author useful no-catalog graphs without invalid dependency or tool placement.
- Added a shared internal authority-policy matrix and removed latent extension-confirm/caller-skill inheritance branches so start planning keeps explicit include-only skill selection and deny/allow extension-source policy.
- Added graph design ladder guidance, `artifact-chained-decision.json`, and cookbook-only Web Research to Local Decision guidance with exact active catalog provenance requirements.
- Added `package:web-researcher` for explicit extension-tool web research and narrowed `package:scout` to local repo/dependency exploration.
- Sharpened bundled catalog role routing copy for local scout, web researcher, planner, critic, reviewer, docs auditor, validator, worker, and synthesizer boundaries.
- Made catalog search route on non-stopword query terms instead of exact full-phrase-only matches, and tightened package role defaults so read-only Scout/Reviewer no longer inherit `bash` unless a step asks for it explicitly.
- Tightened trust-boundary checks so global Pi settings are not treated as project `.pi/settings.json` launch blockers, repo-local caller skills require project-code authority even from subdirectory invocations, and parent messages use escaped JSON payloads instead of delimiter-sensitive raw text.
- Tightened model-facing action/result copy, catalog routing metadata, graph first-success guidance, and fail-closed approved-plan implementation examples without adding new runtime knobs.
- Reworked the interactive live `agent_team` widget, compact tool rows, and pushed notice fallback text into human operator surfaces that prioritize run health, progress, active lanes, queued work, terminal receipts, stop receipts, and attention states without model-facing control guidance.
- Hardened project-root detection, project-agent open-time checks, blank-after-trim planning validation, run-backed error rendering, pushed notice fallbacks, and added an opt-in real Pi smoke target for release-candidate validation.
- Added package release-readiness metadata and human-owned npm publish boundary guidance.
- Updated README, package skill, graph cookbook, examples, catalog tests, package checks, and public-doc checks for the breaking detached-only contract and release guardrails.

## 0.6.2 - 2026-05-07

- Added package-local TypeScript source typechecking to the release gate.
- Refreshed package-local dependencies to their latest pnpm-resolved versions.

## 0.6.1 - 2026-05-07

- Aligned Pi runtime imports, peer dependencies, and package-load tests to the `@earendil-works` Pi 0.74 package scope.
- Added release notes to the packaged npm artifact.
