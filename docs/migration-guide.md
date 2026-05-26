# pi-multiagent migration guide

This guide explains how to migrate to the in-flight `pi-multiagent` (post-0.9.1 Unreleased)
from earlier subagent surfaces. It is written for operators of mixed Pi installs that
may still have `pi-subagents@0.24.2` (unscoped), `@tintinweb/pi-subagents@0.7.3` (scoped),
or in-tree OpenSwarm/Pi-Unified-Swarm references coexisting with pi-multiagent.

## When you should read this

- You are about to remove a reference subagent extension that pi-multiagent now supersedes.
- You wrote a `agent_team` graph against an older pi-multiagent version and want to see what changed.
- You are running mixed extensions and want a clear separation-of-concerns map.

## Architecture reminder

`pi-multiagent` is **not** a drop-in replacement for either `pi-subagents` variant. The
architecture is deliberately different:

| Concern            | pi-multiagent (`agent_team`)            | pi-subagents (both flavors)                             |
| ------------------ | --------------------------------------- | ------------------------------------------------------- |
| Model              | Static DAG with planning-time authority | Free-form chains / single-agent calls                   |
| Child trust        | Unattended, untrusted, evidence-only    | Trusted; can call back via intercom                     |
| Recursion          | Hard-denied (3 layers)                  | Allowed, bounded by PI_SUBAGENT_MAX_DEPTH               |
| Output             | Artifact files + bounded preview        | Inline + optional file mode                             |
| Mid-run steering   | Budgeted `message` with idempotency     | `steer_subagent`, less bounded                          |
| Worktree isolation | F5 (post-0.9.1): opt-in per-step        | Yes, per parallel task                                  |
| Crash resume       | B1a/B1b (post-0.9.1): partial           | Yes (unscoped flavor: tmpfs status.json + events.jsonl) |
| Schedule/cron      | No (NEU-C deferred)                     | Yes (`@tintinweb`)                                      |

## What pi-multiagent v0.9.1+Unreleased adds

### F5 — Per-step git worktree isolation (opt-in)

Add to your graphs when mutation-capable steps need filesystem isolation:

```jsonc
{
  "action": "start",
  "graph": {
    "authority": {
      "allowFilesystemRead": true,
      "allowMutationTools": true,
      "allowMutationWorktree": true, // ← NEW
    },
    "steps": [
      {
        "id": "mut",
        "agent": { "ref": "package:worker" },
        "task": "edit src/foo.ts",
        "mutationScope": "edit allowed under src/",
        "isolation": "worktree", // ← NEW
      },
    ],
  },
}
```

Strict guarantee: any worktree-prepare failure (not a git repo, dirty tree, branch
collision) fails the step closed. No silent fallback to invocation cwd.

### NEU-A B1a — Persistent run state (transparent)

No graph changes required. The extension now:

- Writes per-run state to `${PI_MULTIAGENT_STATE_DIR}` (override) or
  `${XDG_STATE_HOME}/pi-multiagent/runs/` or `~/.local/state/pi-multiagent/runs/`.
- Sweeps orphaned runs at startup and every 6h, cleaning leaked F5 worktrees.
- Fails closed if a worktree-isolated graph cannot establish persistence (FIX-1).

Operator action: ensure the state dir is writable. If not, set
`PI_MULTIAGENT_STATE_DIR=/some/writable/path` before launching Pi.

### NEU-A B1b — `list` and `reattach` actions (new)

```jsonc
{ "action": "list" }
{ "action": "reattach", "runId": "r42" }
```

`list` returns all runs visible from this session plus on-disk orphans. `reattach`
returns a read-only snapshot of an orphaned or terminal run (manifest, status,
worktrees recorded, mirrored artifact paths). Mutation actions (`message`, `cancel`,
`cleanup`) on reattached runs are denied because the original owner process is dead.

### G6/G7 — worktreeSetup (opt-in)

When your F5 mutation step needs `node_modules/` or other gitignored helpers:

```jsonc
{
  "id": "mut",
  "agent": { "ref": "package:worker" },
  "task": "run npm test then commit",
  "mutationScope": "edit allowed under src/",
  "isolation": "worktree",
  "worktreeSetup": {
    "propagateNodeModules": true,
    "symlinkPaths": [".venv", ".env.local"],
  },
}
```

Symlinks, not copies — changes inside the symlinked dir are visible to both parent and
worktree. Path traversal (`..`, absolute paths) is denied with warning, never failure.

### NEU-B — per-step output truncation knobs (opt-in)

```jsonc
{
  "id": "tiny",
  "agent": { "ref": "package:scout" },
  "task": "produce a tight summary",
  "outputLimit": { "maxBytes": 8192, "maxAssistantFinals": 1 },
}
```

Clamps the per-step assistant output budget DOWN from the package-level cap (4 MiB,
64 messages). Setting a value above the package cap is denied at planning time.

### G4 — `pi.events` lifecycle events (transparent)

Other Pi extensions can now react to `agent_team` lifecycle:

```ts
pi.events.on("pi-multiagent:run-started", (payload) => {
  // payload: { runId, objective, stepCount }
});
pi.events.on("pi-multiagent:step-finished", (payload) => {
  // payload: { runId, stepId, status, agentRef, isolation, hasWorktreeEvidence }
});
pi.events.on("pi-multiagent:run-completed", (payload) => {
  // payload: { runId, status, stepStatuses }
});
pi.events.on("pi-multiagent:run-failed-pre-start", (payload) => {
  // payload: { runId, status }  — fires when FIX-1 fail-closed triggers
});
pi.events.on("pi-multiagent:persistent-sweep-complete", (payload) => {
  // payload: { label, scanned, orphans, prunedWorktrees, deletedExpired, warnings }
});
```

## What you should remove (when ready, operator-owned)

Mark's F6 redundant-extension removal is operator-owned. After validating pi-multiagent
covers your delegation needs:

| Package                          | What pi-multiagent covers                                                                                                                                                                      | Operator removal steps                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pi-subagents@0.24.2` (unscoped) | All `agent_team` features cover the planning/execution path; `pi-multiagent` does NOT provide a free-form `subagent({chain:[...]})` API. If you use `/run-chain`, you still need pi-subagents. | `pi uninstall pi-subagents` (only after verifying no slash-commands still depend on it) |
| `@tintinweb/pi-subagents@0.7.3`  | `Agent`, `get_subagent_result`, `steer_subagent` tools are NOT provided by pi-multiagent. Keep both if you use Claude Code-style ad-hoc delegation.                                            | Do not remove unless you no longer use `Agent({ subagent_type: ... })`                  |

## Migration checklist

1. **Backup current configs:** copy `~/.pi/agent/settings.json` and any project `.pi/settings.json` aside.
2. **Verify state dir writability:** `touch ~/.local/state/pi-multiagent/.test && rm ~/.local/state/pi-multiagent/.test` — if this fails, set `PI_MULTIAGENT_STATE_DIR`.
3. **Update existing graphs:**
   - Add `"allowMutationWorktree": false` explicitly if you want to reject `isolation:"worktree"` requests downstream.
   - No other field is required. New fields (`isolation`, `worktreeSetup`, `outputLimit`) are all opt-in.
4. **Subscribe to lifecycle events** in any extension that needs to react to run state changes (G4).
5. **Operator runbook:** read `operator-runbook.md` for the new worktree-leak-recovery and persistence-dir operations.
6. **Manual real-Pi smoke:** run the F5 example graph (`examples/graphs/worktree-isolated-mutation.json`) against a disposable git fixture once before committing this version to production graphs.

## What is NOT migrated (architectural non-goals)

These were considered and intentionally rejected for pi-multiagent. If you need them,
keep a separate subagent extension installed:

- Child→parent intercom (F4 — conflicts with unattended-child model)
- Recursive `agent_team` calls (F1 — denied at 3 layers)
- Cross-host registry (out-of-scope per NEU-A ADR §8)
- Child process resurrection / reattach with live control (B1b reattach is read-only)
- Schedule/cron (NEU-C — deferred to its own ADR; use a separate scheduler extension or external cron + `agent_team start` for now)

## Rollback

Each new slice (PRE, F5, B1a, B1b, etc.) has its own pre-edit backup in
`~/.pi/agent/maintenance/pi-multiagent-*-2026-05-26/backup/` with rollback instructions
in the receipt README.
