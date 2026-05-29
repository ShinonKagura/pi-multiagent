# hb-orchestra — Schema Locks (L2 documented · L4/L5 pre-implementation)

**Purpose:** schema-first discipline. L2's profile schema is documented here (it is implemented); L4 and L5 schemas are **locked before code** so implementation cannot drift. Closes audit gaps **D8** (profile schema was only illustrative) and **D9** (ledger/replay manifest described but unspecified), and gives L4 a concrete contract.

**Status:** L2 = implemented + tested. L4 = locked, not implemented (roadmap 7.4). L5 = locked, not implemented (roadmap 7.5).

---

## 1. Profile schema (L2 — implemented)

File: `.pi/profiles/<name>.{json|md}` (project-scoped). Markdown uses YAML frontmatter; JSON uses the same fields with `sharedSystemPrompt` as a top-level string.

```
kind:        "chain" | "parallel"                 (required)
agents:      ProfileAgentSpec[]                    (required, non-empty)
name?:       string                                (defaults to file basename)
description?: string
tags?:       string[]
# markdown body OR json sharedSystemPrompt = shared system prompt appended to each member
```

`ProfileAgentSpec`:
```
subagent_type: string                              (required; resolved by L1)
model?:        string
fallbackModels?: string[]                          (captured; active resolution is v0.7)
thinking?:     off|minimal|low|medium|high|xhigh|inherit
tools?:        string[]
inherit_context?: boolean
max_turns?:    integer >= 1
```

Supported markdown-frontmatter subset (documented to avoid silent misparse — relates to audit D7): top-level scalars, `agents:` list with `- subagent_type: ...` items and 2-space nested scalars, `[a, b]` inline arrays, comma lists for `tools`/`fallbackModels`/`tags`, `true`/`false` booleans, quoted strings. Multiline/complex YAML is **not** supported in v0.5; use JSON for anything richer.

Composition rule (`resolveProfile`): each member = persona frontmatter defaults **overridden by** the profile agent spec; `systemPrompt = persona.body` + (`---` + shared body) when a shared body is present. Examples: `examples/profiles/cross-model-review.json` (parallel), `examples/profiles/analyze-then-review.md` (chain).

---

## 2. Harness contract schema (L4 — LOCKED, not implemented)

Invariant I6: **read-only, opt-in, no authority monopoly.** The package reads `.pi/harness/` (project) or `.agents/harness/` (workspace) if present, injects content into child system prompts, and may constrain tool allowlists — but never writes these paths, registers global gates, or installs always-on hooks.

Locked file shapes (all optional; absence = feature off):

```
.pi/harness/plan-packet.md          PlanPacket-lite: objective, assumptions,
                                    success-criteria[], scope-allow[], scope-deny[],
                                    stop-conditions[]. Injected as a required-plan
                                    preamble for profiles that opt in via
                                    `harness: { requirePlan: true }`.
.pi/harness/mutation-scope.md       Default mutationScope text applied when a
                                    mutation-capable step omits its own scope.
.pi/harness/review-gate.md          Review-gate contract: reviewer roles + the
                                    four convergence fields (Iterations, Confidence,
                                    Resolved, Remaining) a review profile must emit.
.pi/harness/artifact-ready.md       Artifact-readiness checklist injected into
                                    worker/reviewer prompts.
.pi/harness/repair-brief.md         Repair-brief format for bounded fix loops.
.pi/harness/receipt.md              Trace-receipt schema for run closure.
```

Reader contract (to implement in L4):
- Resolve project path first, then workspace path; never merge silently across both — project shadows workspace, record a diagnostic when both exist.
- Return a `HarnessContract { plan?, mutationScopeDefault?, reviewGate?, artifactReady?, repairBrief?, receipt?, sources[] }` plus diagnostics; pure, no side effects.
- Hard rule: any write attempt to a harness path is a bug. L4 has read + stat only.

---

## 3. Reproducibility ledger schema (L5 — LOCKED, not implemented)

Invariant I5. State root: `$HB_ORCHESTRA_STATE_DIR` else `$XDG_STATE_HOME/hb-orchestra/runs/` else `~/.local/state/hb-orchestra/runs/`. (Migration note D12: the inherited substrate still uses `pi-multiagent` state; L5 owns the `hb-orchestra` namespace and must document a one-time migration/compat path.)

Per-run layout `…/runs/<run_id>/`:
```
manifest.json   see schema below
prompt.txt      final composed system + task prompt per step
harness/        snapshot of harness files read at run time (if any)
artifacts/      mirrored step artifacts (reuses substrate G1 mirror)
events.jsonl    append-only event log (reuses substrate events)
replay.json     everything needed to re-run deterministically
```

`manifest.json` (locked):
```json
{
  "schemaVersion": "1",
  "runId": "string",
  "createdAt": "ISO-8601",
  "objective": "string",
  "source": { "kind": "agent|profile|graph", "name": "string|null" },
  "graph": { "objective": "string", "authority": { }, "steps": [ ] },
  "steps": [
    {
      "id": "string",
      "subagent_type": "string|null",
      "model": "string|null",
      "thinking": "string|null",
      "tools": ["string"],
      "mutationScope": "string|null",
      "isolation": "worktree|null",
      "systemPromptSha256": "hex",
      "inputArtifactHashes": ["sha256"],
      "outputArtifactPaths": ["string"],
      "outputArtifactHashes": ["sha256"]
    }
  ],
  "runHash": "sha256"
}
```

`runHash = sha256(system_prompt + harness_files + tools + model + task + context_files)` per ARCHITECTURE I5, computed per step and folded into a stable run-level digest (define fold order = step id ascending).

`replay.json` = `{ schemaVersion, runId, graph, perStepComposedPrompt[], modelIds[], toolGrants[], harnessSnapshotRef }` — sufficient for `/agent replay <run_id>` to reconstruct the identical `agent_team` start graph without re-resolving personas/profiles.

Implementation order: write manifest at `start` (pre-spawn) with input hashes; append output paths/hashes at each step terminal; finalize `runHash` + `replay.json` at run terminal. All writes best-effort and must never block or fail the run (mirror substrate G1/G4 discipline).
