# pi-multiagent operator runbook

Day-to-day operational procedures for pi-multiagent post-0.9.1+Unreleased. Aimed at the
operator (Mark, or whoever runs Pi sessions), not at the model.

## Quick reference

| Procedure                            | Section                                                               |
| ------------------------------------ | --------------------------------------------------------------------- |
| Set up the persistent state dir      | [Persistent state dir](#persistent-state-dir)                         |
| Find and recover orphan F5 worktrees | [F5 worktree leak recovery](#f5-worktree-leak-recovery)               |
| Inspect a crashed/orphaned run       | [Reattach to an orphaned run](#reattach-to-an-orphaned-run)           |
| Clean up phantom intercom sessions   | [Stale intercom sessions](#stale-intercom-sessions)                   |
| Read the startup sweep stderr line   | [Reading startup sweep output](#reading-startup-sweep-output)         |
| Roll back a slice                    | [Slice rollback](#slice-rollback)                                     |
| Disable worktree isolation entirely  | [Disable worktree isolation](#disable-worktree-isolation)             |
| Bump retention or sweep cadence      | [Tune retention and sweep cadence](#tune-retention-and-sweep-cadence) |

## Persistent state dir

pi-multiagent now writes per-run state to disk so crashed runs can be detected and
cleaned up at the next extension activation.

**Resolution order** (first match wins):

1. `$PI_MULTIAGENT_STATE_DIR` environment override (treated as the runs/ root itself).
2. `$XDG_STATE_HOME/pi-multiagent/runs/`
3. `~/.local/state/pi-multiagent/runs/`
4. `${TMPDIR}/pi-multiagent-state/` (degraded — does not survive reboots cleanly)

**Pre-flight check:**

```bash
# Verify the state dir is writable
STATE_DIR="${PI_MULTIAGENT_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/pi-multiagent/runs}"
mkdir -p "$STATE_DIR" && touch "$STATE_DIR/.write-check" && rm "$STATE_DIR/.write-check" && echo "OK: $STATE_DIR is writable"
```

If this fails, set `PI_MULTIAGENT_STATE_DIR` to a writable path before launching Pi.

**Disk usage:** each run dir contains ≤ ~10 KiB of JSON + mirrored artifacts (typically
a few KiB per step's final.md and worktree.patch). Default retention is 24h after
terminal status, sweep prunes expired runs at startup and every 6h.

## F5 worktree leak recovery

If Pi crashes mid-step with an active worktree-isolated step, the next extension
activation runs the startup sweep automatically. You will see a stderr line like:

```
[pi-multiagent] startup sweep: scanned=3 orphans=1 prunedWorktrees=1 deletedExpired=0
```

The sweep removes leaked worktrees recorded in the orphan's `worktrees.json`, plus any
orphan `pi-multiagent/*` branches from partial teardown.

**Manual recovery** (when the sweep cannot reach the leak, e.g. orphan was created with
`persistent-run-unavailable-with-worktree` failing closed, OR Pi was never restarted):

```bash
# List leaked worktrees across all your repos (system-wide)
ls /tmp/pi-multiagent-wt-* 2>/dev/null

# In the affected repo:
cd /path/to/affected/repo

# Remove all pi-multiagent worktree refs
git worktree prune

# Remove any orphan pi-multiagent/* branches that no longer have a worktree
for br in $(git for-each-ref --format='%(refname:short)' refs/heads/pi-multiagent/); do
  if ! git worktree list --porcelain | grep -q "branch refs/heads/$br"; then
    echo "Removing orphan branch: $br"
    git branch -D "$br"
  fi
done

# Verify
git worktree list
git branch -a | grep pi-multiagent || echo "No orphan branches remain"
```

## Reattach to an orphaned run

The new `list` and `reattach` agent_team actions surface persistent runs:

```jsonc
// In the parent Pi session
{ "action": "list" }
// → returns listedRuns: [{ runId, owner, status, runDir, worktreesPendingCleanup, ... }, ...]

// To inspect a specific orphan:
{ "action": "reattach", "runId": "r42" }
// → returns reattach: { manifest, status, worktrees, artifactPaths, readOnly: true, controlDenied: true }
```

`reattach` is read-only. The mirrored artifact paths point at `artifacts/<stepId>-final.md`
and `artifacts/<stepId>-worktree.patch` inside the run dir; copy them out before letting
retention expire them.

## Stale intercom sessions

`intercom list` may show `[idle]` sessions that are actually dead (the session owner
exited without notifying intercom). Symptom: `intercom ask <stale-session> ...` hangs
for 10 minutes then times out.

**Fix:**

```bash
# Dry-run: see which sessions intercom considers stale
intercom clean --olderThanMinutes 30

# Apply removal
intercom clean --olderThanMinutes 30 --confirm
```

For adversarial-review or second-opinion needs, prefer the `Agent` tool over `intercom ask`.
The `Agent` tool spawns a fresh peer deterministically.

## Reading startup sweep output

The extension emits one stderr line per non-trivial sweep:

```
[pi-multiagent] startup sweep: scanned=N orphans=N prunedWorktrees=N deletedExpired=N [warnings=N]
[pi-multiagent] periodic sweep: ... (every 6h)
```

If `warnings=N` is present, inspect the operator's terminal or pipe stderr to a file
to see the individual warning lines (e.g. `[pi-multiagent] startup sweep failed: ...`).

The `pi.events` `pi-multiagent:persistent-sweep-complete` event carries the same
structured fields for programmatic consumption by other extensions.

## Slice rollback

Each new slice has its own backup directory:

| Slice         | Backup                                                                            | Receipt         |
| ------------- | --------------------------------------------------------------------------------- | --------------- |
| PRE preflight | `~/.pi/agent/maintenance/pi-multiagent-preflight-drift-2026-05-26/backup/`        | `.../README.md` |
| F5 worktree   | `~/.pi/agent/maintenance/pi-multiagent-F5-worktree-2026-05-26/backup/` (13 files) | `.../README.md` |
| NEU-A B1a     | `~/.pi/agent/maintenance/pi-multiagent-NEU-A-B1a-2026-05-26/backup/`              | `.../README.md` |

Each receipt's "Rollback" section has the exact `cp` commands. Slices are orthogonal:
rolling back B1a does NOT roll back F5; rolling back F5 does NOT roll back PRE.

## Disable worktree isolation

If you want to forbid all `isolation:"worktree"` requests across all graphs run by this
Pi install:

- Easiest: do not set `graph.authority.allowMutationWorktree:true` in your graphs.
  Without the graph authority, any `isolation:"worktree"` step is rejected at planning
  time with `worktree-authority-required` (no runtime side effects).
- Stricter: there is no global "disable" flag yet. If you need one, file it as a NEU
  feature request and we can add `--agent-team-allow-worktree-isolation=false`.

## Tune retention and sweep cadence

- **Per-graph retention:** set `options.terminalRetentionSeconds` on `start`. Default 86400 (24h), max 604800 (7d).
- **Sweep cadence:** currently hard-coded at 6h. Lower the value in
  `extensions/multiagent/index.ts` (`PERIODIC_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000`)
  if your installation has high churn. Higher = lower I/O cost but slower disk-cleanup.

## Common failure modes

| Symptom                                             | Diagnosis                                       | Action                                                                           |
| --------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `persistent-run-unavailable-with-worktree` at start | State dir not writable AND graph has F5 step    | Set `PI_MULTIAGENT_STATE_DIR` to a writable path                                 |
| `persistent-run-unavailable` warning (no fail)      | State dir not writable but graph has no F5 step | Same — fix state dir; otherwise this run cannot be reattached                    |
| Step fails with `worktree-tree-dirty`               | Repo has uncommitted changes                    | Commit, stash, or discard before retrying                                        |
| `worktree-branch-exists`                            | Previous partial teardown left the branch       | `git branch -D pi-multiagent/<runId>/<stepId>`                                   |
| Step seems to hang at `worktree-prepared` event     | Slow first git op (cold cache, NFS, large repo) | Increase per-step timeout via `graph.limits.timeoutSecondsPerStep`               |
| Sweep stderr says `worktree-cleanup-warning`        | Best-effort teardown saw a git-level issue      | Inspect the warning text; usually safe to ignore once the next sweep picks it up |

## When to escalate

- Persistent state dir cannot be made writable AND you need F5 worktree isolation: this is
  a fundamental incompatibility. Either fix the filesystem layer, or run without F5.
- Sweep stderr lines repeat the same warning on every Pi restart: file a bug with the warning text.
- `git worktree list` shows worktrees the sweep cannot remove: file a bug with `git worktree list --porcelain` output.
