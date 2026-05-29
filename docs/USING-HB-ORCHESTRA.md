# Using hb-orchestra (v0.5 — usable, not yet API-frozen)

A practical guide to delegating work through hb-orchestra. The compat surface (Layer 6), harness
governance (Layer 4), and the reproducibility ledger (Layer 5) are wired, tested, and verified in a
real Pi. This is **v0.5**: usable for delegation/review/workflows, but the public API is not frozen
and a few enforcement/parse features are still pending (see "Not yet" at the end).

## Launch

hb-orchestra is installed as a package, so just start Pi normally:

```bash
pi
```

The `Agent`, `Profile`, `Replay` tools and the `/agent`, `/profile`, `/replay`, `/harness` commands
plus the inherited `agent_team` tool are available in every session. Do **not** also `-e` the fork —
that double-registers `agent_team`.

Model note: persona/profile members use their frontmatter `model`; members without one fall back to
the session model. If your default model is unavailable (e.g. an exhausted Anthropic "extra usage"
subscription), pin a working one: `pi --model openai/gpt-4o`. The substrate bills whichever provider
the resolved model uses.

## Delegate one persona

```
/agent coding_reviewer "review src/foo.ts"
```
or, model-callable (the LLM picks tools/model):
```
Agent({ subagent_type: "coding_reviewer", prompt: "review src/foo.ts" })
```

It resolves the persona (`.pi/agents/<name>.md`), starts a **detached** child run, and returns a
`runId` immediately. Optional fields on the `Agent` tool: `model`, `thinking`, `tools` (strict
allowlist override), `mutationScope`, `isolation:"worktree"`, and `waitSeconds`.

## Get the result (detached by default)

`/agent` returns a `runId`, not the answer. Inspect it:
```
get_subagent_result({ runId: "<id>", waitSeconds: 30 })     # run status + outputs (waits up to 30s)
get_subagent_result({ runId: "<id>", stepId: "<step>" })    # one step's full output
agent_team({ action: "run_status", runId: "<id>", waitSeconds: 30, preview: true })
```
Or get the answer inline by blocking at start (bounded, capped 600s; returns the runId on timeout):
```
Agent({ subagent_type: "reviewer", prompt: "...", waitSeconds: 120 })
```

## Steer a running child

```
steer_subagent({ runId: "<id>", message: "focus on error handling" })
```
Auto-resolves the live step when there is exactly one; pass `stepId` for multi-step runs. Only works
while a step is live (a finalized child returns a clear "message-not-delivered" notice).

## Run a saved workflow (chain / parallel)

Define `.pi/profiles/<name>.{md|json}` (see `examples/profiles/`), then:
```
/profile review-team "review this diff"
Profile({ profile: "review-team", task: "review this diff", waitSeconds: 90 })
```
A `parallel` profile runs all members from the same input; a `chain` profile runs them in order with
dependencies. Members resolve to personas via Layer 1/2/3.

## Reproduce / replay a run

Every start computes a deterministic `run_hash` (over objective + per-step prompt/tools/model/task +
authority + injected harness rules), emits a `hb-orchestra:run-hash` event, appends `run_hash=...` to
the start result, and persists a replay manifest under
`$XDG_STATE_HOME/hb-orchestra/replay/<run_hash>.json` (or `$HB_ORCHESTRA_STATE_DIR`/`~/.local/state`).
Re-run the identical graph (the replay's run_hash matches the original):
```
/replay <run_hash>            # also accepts a unique hash prefix, or a recent runId
Replay({ runId: "<run_hash>", waitSeconds: 60 })
```

## Optional governance (Layer 4 harness contract)

Drop a read-only contract at `.pi/harness/contract.json` (project) or `.agents/harness/contract.json`
(workspace) — see `examples/harness/contract.json`. hb-orchestra reads it (never writes) and, on
`Agent`/`Profile` runs:
- **injects** the text of `systemPromptFiles` into each step's system prompt;
- **blocks** mutating runs (edit/write tools, a `mutationScope`, or worktree isolation) when
  `mutationAllowed: false` (error `harness-mutation-denied`).

Inspect the discovered contract:
```
/harness
```

## Coding / write tasks (mutation)

- Read-only delegation (review, research, analysis) is the safest, ready path.
- For write-capable children, set `mutationScope` and prefer `isolation: "worktree"` so changes land
  on a throwaway branch. The substrate denies mutation steps that lack a `mutationScope`.
- A persona that declares `bash` cannot run via `/agent` from a directory containing project
  `.pi/settings.json` (fail-closed `bash-project-settings-denied`, OPEN-3). Use the `Agent` tool with
  a `tools` override dropping bash, grant explicit project-code trust, or run from a non-settings cwd.

## Caveats (v0.5)

- **Async by default** — inspect results with `get_subagent_result`, or pass `waitSeconds`.
- **Child quality = persona + model** — the plumbing is solid; use capable models for real work.
- **API not frozen** — internal interfaces may change before v1.0.

## Not yet (tracked for later)

- L4: path-allowlist / forbidden-path **enforcement** (currently a contract field but not enforced at
  tool-broker depth); parsing the full nested-YAML PlanPacket.
- v0.7: runtime fallback, lifecycle events, cross-extension RPC, a `<pid>`-namespaced runId for truly
  concurrent same-machine processes.
- v1.0: frozen public API, publish, migration guide, examples + public test matrix.

See `docs/hb-orchestra-status.md` for the live layer/feature matrix and `ROADMAP.md` for the plan.
