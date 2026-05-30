# Migrating from pi-subagents to hb-orchestra

hb-orchestra's Layer 6 (compat surface) is built to be a **near drop-in replacement** for
`pi-subagents` (both the unscoped `pi-subagents` and `@tintinweb/pi-subagents` flavors): it registers
the same `Agent` / `get_subagent_result` / `steer_subagent` tools and `/agent` command with a
pi-subagents-compatible parameter shape, and reads personas from the same `.pi/agents/<name>.md`
location. Most callers and personas keep working unchanged; the rest of this guide maps the deltas.

> Substrate note: the lower-level detached `agent_team` graph API is documented separately in
> `docs/migration-guide.md`. This guide is the persona/Agent-surface migration. The frozen public
> contract is `docs/API.md`.

---

## 1. Tools — mostly unchanged

| pi-subagents | hb-orchestra | Notes |
| --- | --- | --- |
| `Agent({ subagent_type, prompt, ... })` | `Agent({ subagent_type, prompt, ... })` | Same tool, same core params. |
| `get_subagent_result({ ... })` | `get_subagent_result({ runId, stepId?, waitSeconds? })` | Same tool. |
| `steer_subagent({ ... })` | `steer_subagent({ runId, message, stepId? })` | Same tool. |
| `/agent <persona> "<task>"` | `/agent <persona> "<task>"` | Same command. |

```jsonc
// Before (pi-subagents) and after (hb-orchestra) are identical for the common case:
Agent({ subagent_type: "coding_reviewer", prompt: "review src/foo.ts" })
```

The `Agent` tool accepts the pi-subagents-compatible fields (`subagent_type`, `prompt`, `model`,
`thinking`, `tools`, `isolation`, and background/foreground intent). Internally each call maps to a
single-step detached graph.

## 2. Foreground vs background → detached + `waitSeconds`

pi-subagents returned the result inline (foreground) or an id (background). hb-orchestra is
**detached by default** and returns a `runId` immediately; ask for an inline result with `waitSeconds`.

```jsonc
// Before: foreground call that blocked for the answer
Agent({ subagent_type: "reviewer", prompt: "review" })            // returned the result

// After: block inline (bounded, capped 600s; returns runId on timeout)
Agent({ subagent_type: "reviewer", prompt: "review", waitSeconds: 120 })

// Or detached (default): get the answer later
const { runId } = Agent({ subagent_type: "reviewer", prompt: "review" })
get_subagent_result({ runId, waitSeconds: 30 })
```

## 3. Chains / parallel fan-out → Profiles

Where pi-subagents used an ad-hoc chain/parallel DSL, hb-orchestra uses a saved **Profile**
(`.pi/profiles/<name>.{md,json}`, a `chain` or `parallel` of personas) run via `/profile` or the
`Profile` tool:

```jsonc
Profile({ profile: "review-team", task: "review this diff", waitSeconds: 90 })
```

## 4. Personas — same location, new optional fields

`.pi/agents/<name>.md` frontmatter is compatible. New optional fields you may add:
- `fallbackModels: [ ... ]` — tried in order if the primary model fails with a model/provider error.
- `systemPromptMode: append | replace`, `inheritProjectContext`, etc. (see `docs/API.md`).

## 5. Cross-extension RPC — same channels

If an extension drove pi-subagents over `subagents:rpc:*`, hb-orchestra answers the same channels with
reply envelopes (see `docs/API.md` §9):

```ts
pi.events.on("subagents:rpc:reply", (r) => { /* { id, method, ok, result?|error? } */ });
pi.events.emit("subagents:rpc:ping",  { id: "1" });
pi.events.emit("subagents:rpc:spawn", { id: "2", params: { graph: { /* agent_team start graph */ } } });
pi.events.emit("subagents:rpc:stop",  { id: "3", params: { runId: "r1" } });
```

## 6. Lifecycle events — dual-branded

Run lifecycle events are emitted under **both** the legacy `pi-multiagent:` prefix and the new
`hb-orchestra:` brand, so existing subscribers keep working while you migrate:

```ts
// Old subscribers keep working:
pi.events.on("pi-multiagent:run-completed", (p) => { /* ... */ });
// New brand (preferred):
pi.events.on("hb-orchestra:run-completed", (p) => { /* { runId, status, stepStatuses } */ });
pi.events.on("hb-orchestra:run-failed",    (p) => { /* status-specific terminal event */ });
```

## 7. What's new in hb-orchestra (no pi-subagents equivalent)

- **Reproducibility:** every run gets a deterministic `run_hash`; re-run it with `/replay <run_hash>`.
- **Harness governance:** an optional read-only `.pi/harness/contract.json` can block mutating runs
  that target forbidden paths and inject a path/scope policy into child prompts.
- **Worktree isolation:** mutating steps can run in a throwaway git worktree (`isolation: "worktree"`).
- **Runtime model fallback:** `fallbackModels` retries the next model on a model/provider failure.

## 8. Architectural deltas (intentional non-goals)

hb-orchestra's children are **unattended, untrusted, evidence-only**. The following pi-subagents
behaviors are deliberately **not** carried over:
- child → parent intercom / callbacks,
- recursive subagent calls (denied),
- trusted child control loops.

If you depend on those, keep a separate subagent extension for that workload.

## 9. Removing pi-subagents

Once your delegation, RPC, and persona flows are validated on hb-orchestra, uninstall the old
extension(s). Keep a backup of `~/.pi/agent/settings.json` and any project `.pi/settings.json` first.
(In the maintained Stellar install, `pi-subagents`/`pi-multiagent` npm removal was already completed
and validated — see `ROADMAP.md` 7.8.)

---

_See `docs/API.md` for the frozen public contract and `docs/USING-HB-ORCHESTRA.md` for day-to-day usage._
