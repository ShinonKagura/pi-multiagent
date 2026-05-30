# hb-orchestra Public API (v1.0 contract)

This is the **frozen** public surface of hb-orchestra. From v1.0, these contracts follow semver:
additive changes are minor; renames/removals/semantic changes are major. The machine-checkable parts
are guarded by `tests/orchestra-api-contract.test.ts` — a failure there means a public contract moved
and the change must be deliberate (update the test + this doc + bump the version).

Anything **not** listed here (internal module layout, substrate `pi-multiagent` internals, event
payload extras, diagnostic codes, log/notice wording) is **not** part of the contract and may change.

---

## 1. Tools (model-callable)

### `Agent`
Delegate one persona to a detached run. Returns a `runId` (or, with `waitSeconds`, the inline result).
Stable parameters:
- `subagent_type` (string, required) — persona name (`.pi/agents/<name>.md`).
- `prompt` (string, required) — the task.
- `model?` (string) — `<provider>/<model>` override.
- `thinking?` (string) — thinking level (`inherit` keeps parent default).
- `tools?` (string[]) — strict child tool allowlist override.
- `mutationScope?` (string) — declared write zone (required for mutating steps).
- `isolation?` (`"worktree"`) — per-step git-worktree isolation.
- `waitSeconds?` (number) — bounded foreground wait (capped 600s; returns the runId on timeout).

### `Profile`
Run a saved workflow (`.pi/profiles/<name>.{md,json}`). Parameters: `profile` (string, required),
`task` (string, required), plus the same `waitSeconds?` semantics.

### `Replay`
Re-launch a stored run by fingerprint. Parameters: `runId` (string, required — a full `run_hash`, a
unique hash prefix, or a recent runId), `waitSeconds?`.

### `get_subagent_result` / `steer_subagent`
- `get_subagent_result({ runId, stepId?, waitSeconds? })` → run status + outputs.
- `steer_subagent({ runId, message, stepId? })` → deliver a steer to a live step.

### `agent_team` (substrate)
The detached-only lifecycle tool. Its TypeBox input schema (action + graph/runId/options) is the
substrate contract; `start` returns a `run.runId`.

## 2. Slash commands
`/agent <persona> "<task>"`, `/profile <name> "<task>"`, `/replay <run_hash|runId>`, `/harness`.

## 3. Persona schema — `.pi/agents/<name>.md` frontmatter
Stable fields: `name` (required), `description?`, `tags?` (string[]), `model?`, `fallbackModels?`
(string[], tried in order on a retryable model/provider failure), `thinking?`, `tools?` (string[]),
`systemPromptMode?` (`"append"|"replace"`), `inheritProjectContext?` (bool), plus skills/context/
extension fields. The markdown body is the child system prompt.

## 4. Profile schema — `.pi/profiles/<name>.{md,json}`
A `chain` or `parallel` profile of members; each member resolves to a persona (Layer 1) and may
override `model`, `fallbackModels`, `tools`, `thinking`, context, skills, and a shared system prompt.

## 5. Harness contract — `.pi/harness/contract.json` (project) or `.agents/harness/contract.json` (workspace)
Read-only project governance (hb-orchestra never writes it). Discovery surface is **frozen**: filenames
`["contract.json", "harness.json"]`, search order project (`.pi/harness`) then workspace
(`.agents/harness`). Stable governance fields: `mutationAllowed?`, `mutationScope?`, `allowedPaths?`,
`forbiddenPaths?`, `externalSideEffectsAllowed?`, `approvalGateRequired?`, `reviewGateRequired?`,
`artifactReadyBeforeReview?`, `systemPromptFiles?`, `planPacketPath?`. Enforcement: a mutating step
whose `mutationScope` targets a `forbiddenPath` is blocked (`harness-policy-denied`); the path/scope
policy is injected into child prompts.

## 6. Graph authority keys (frozen set)
`allowFilesystemRead`, `allowShellTools`, `allowMutationTools`, `allowExtensionCode`,
`allowProjectCode`, `allowMutationWorktree`. Mutating steps require an explicit `mutationScope`;
worktree isolation additionally requires `allowMutationWorktree`.

## 7. Reproducibility — `run_hash` + replay manifest
- `run_hash`: a deterministic SHA-256 over the composed run inputs (objective + per-step
  prompt/tools/model/task + authority + any injected harness rules). Emitted as a
  `hb-orchestra:run-hash` event and appended to `Agent`/`Profile` start results.
- Replay manifest (`<run_hash>.json` under `$HB_ORCHESTRA_STATE_DIR | $XDG_STATE_HOME | ~/.local/state`
  `/hb-orchestra/replay`): frozen field set `{ schemaVersion: 1, runHash, objective, graph, createdAt,
  harnessContractHash? }`, with an `index.jsonl` mapping recent runId → runHash.

## 8. Lifecycle events (on `pi.events`)
Every run lifecycle event is emitted under both the legacy `pi-multiagent:` prefix and the
`hb-orchestra:` brand:
- `hb-orchestra:run-started` `{ runId, objective, stepCount }`
- `hb-orchestra:step-finished` `{ runId, stepId, status, agentRef, isolation, hasWorktreeEvidence }`
- `hb-orchestra:run-completed` `{ runId, status, stepStatuses }`
- `hb-orchestra:run-<status>` (`run-succeeded|run-failed|run-canceled|run-timed_out`) `{ runId, status }`
- `hb-orchestra:run-failed-pre-start` `{ runId, status }`
- `hb-orchestra:run-hash` (the reproducibility fingerprint)

## 9. Cross-extension RPC (on `pi.events`)
Request → `emit("subagents:rpc:<method>", { id?, params? })`; reply → `emit("subagents:rpc:reply",
{ id?, method, ok, result?|error? })`. Frozen channels: `subagents:rpc:ping`, `subagents:rpc:spawn`,
`subagents:rpc:stop`, `subagents:rpc:reply`. Methods: `ping` (result `{ pong, extension, version }`),
`spawn` (params `{ graph }`, result `{ runId }`), `stop` (params `{ runId }`, result
`{ runId, stopped }`).

---

_Machine-checked subset: `tests/orchestra-api-contract.test.ts` (run_hash determinism, replay manifest
field set + schemaVersion, RPC channels, harness discovery surface, authority key set)._
