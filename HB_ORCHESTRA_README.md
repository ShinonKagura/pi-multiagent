# hb-orchestra

**Detached multi-agent orchestration for Pi — with `Agent()` compatibility, persona/profile composition, harness contracts, and a reproducibility ledger.**

Fork of `pi-multiagent` (Tiziano-AI/pi-multiagent v0.10.0) with extended product scope. Upstream contributions remain in their canonical home; this fork carries the features Tiziano explicitly declined to take.

---

## Status

**v0.5.0-pre** — foundation in progress. Implementation slices land in `extensions/orchestra/`.

- Spec / design lock: [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 8 invariants, 6-layer architecture, 7 anti-patterns.
- Roadmap: [`ROADMAP.md`](./ROADMAP.md).
- **What actually exists vs planned: [`docs/hb-orchestra-status.md`](./docs/hb-orchestra-status.md)** — the single source of truth tying docs → code → tests.

Implemented today: Layer 1 (agent-registry), Layer 2 (profile-engine composition), Layer 3 (profile→detached-graph mapping), and a Layer 6 minimal slice (`Agent` tool + `/agent` command). Everything else below is a v0.5 target, not a shipped feature.

---

## Why fork?

Tiziano's `pi-multiagent` has deliberate design boundaries:
- detached-only execution (no `Agent()`-style foreground)
- no `.pi/agents/<name>.md` persona reader
- no profile composition / cross-model review as first-class
- intercom integration is non-goal

These are reasonable choices for his package. They are not what we need for our daily workflow. `hb-orchestra` keeps the rock-solid detached substrate Tiziano built and adds:

| Feature | Status |
|---------|--------|
| `Agent()` tool surface (pi-subagents-compatible) | Implemented today (detached/background; foreground wait pending) |
| `/agent` slash command | Implemented today |
| `/profile` slash command | Target v0.5 (L2/L3 logic done, not yet wired) |
| `.pi/agents/<name>.md` persona reader (with `model + fallbackModels`) | Implemented today |
| `.pi/profiles/<name>.{json|md}` profile composition (chain / parallel) | Implemented today (composition + graph mapping; not yet command-invokable) |
| Reproducibility ledger (run manifest, replay) | Target v0.5 (not started) |
| Harness contracts (read-only `.pi/harness/` opt-in) | Target v0.5 (not started) |
| Detached agent_team graph runtime | Inherited from pi-multiagent |
| Worktree isolation (with uncommitted-loss + step.cwd fixes) | Inherited + locally fixed |
| Persistent state + reattach | Inherited (B1a + B1b) |
| Scheduling (cron / interval / one-shot) | Inherited (NEU-C) |

---

## Quick spec

```
Layer 1 — agent-registry         .pi/agents/<name>.md reader, persona catalog
Layer 2 — profile-engine         compose persona + model + tools + skills
Layer 3 — execution-runtime      detached DAG (from pi-multiagent)
Layer 4 — harness-contracts      optional governance, no execution monopoly
Layer 5 — reproducibility-ledger run manifest + replay
Layer 6 — compat-surface         Agent(), /agent, /profile
```

---

## Installation

Not yet released. v0.5.0-pre is for local development only.

When v0.5 ships:

```bash
pi install npm:hb-orchestra
```

---

## Relationship to other packages

`hb-orchestra` is intended to make these obsolete in our workspace once v0.5 ships:

- `pi-subagents` (0.24.2 by nicobailon) — Agent() tool surface replaced
- `@tintinweb/pi-subagents` (0.7.3) — patterns adapted, can be removed
- `taskplane` (0.30.1) — orchestrator-pattern reference, v2 may replace

Stays alongside (different concerns):
- `pi-multiagent` (upstream Tiziano) — we contribute fixes back, evolve independently
- `pi-intercom` — session-coordination
- `pi-lens`, `pi-hermes-memory`, `pi-agent-browser-native`, `pi-web-access` — unrelated
- `@runfusion/fusion` — task board, unrelated

References (selectively adapted, NOT installed as authority):
- `ultimate-pi` — harness-contract patterns
- `@companion-ai/feynman` — optional research provider

---

## License

MIT. Same as upstream `pi-multiagent`.

---

## Acknowledgements

Without Tiziano Contorno's `pi-multiagent` (the detached substrate), `hb-orchestra` would not exist. Today (2026-05-27) we contributed 3 focused upstream PRs and 3 proposal issues back to that repo before forking. Thank you.
