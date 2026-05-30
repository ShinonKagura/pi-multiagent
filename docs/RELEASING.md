# Releasing hb-orchestra

The actual publish is **operator-owned**: it needs registry credentials and a deliberate decision to
cut a version. This doc is the runbook; the package itself is prepared and the public contract is
frozen (`docs/API.md`).

## Status: package prepared, publish pending an operator

Done (committed):
- Package identity: `name: hb-orchestra`, `publishConfig.access: public`.
- `files` ships the runtime surface incl. example personas/profiles (`examples/**/*.json` +
  `examples/**/*.md`); the stale `pi-multiagent-gallery.webp` marketing asset is no longer shipped.
- Packaging guards pass: `pnpm run check:pack` (size + file-count budgets reflect the grown package)
  and `pnpm run check:source-size`.
- `pnpm run check:release` passes its identity/structure assertions (name, semver shape,
  packageManager, engine, publishConfig). Its remaining assertions are **release-time gates** (see
  below): clean tree, CHANGELOG release section, version not already published.

Known follow-ups (pre-existing inherited-debt, NOT blocking the package's correctness; tracked):
- `check:public-docs` enforces a documentation-fragment contract over `README.md`/`SKILL.md` that has
  drifted from the rebrand + the v0.10 substrate redesign (some required fragments describe behavior
  that was intentionally changed, e.g. the old `package:validator requires effective bash` hard
  rejection — now a cap-and-warn). Re-adding those would document removed behavior; this check needs a
  separate reconciliation pass against current behavior. (Dead example-graph links in `SKILL.md` were
  already fixed.)
- `check:pi-load` was written for the single-extension package and asserts `agent_team` per extension
  with an incomplete mock for the orchestra extension's `registerCommand`; needs a multi-extension
  rewrite.

## Release steps (operator)

1. Decide the version (e.g. `1.0.0`) and update `package.json` `version`.
2. Move the `CHANGELOG.md` Unreleased entries under a dated release heading
   `## <version> - YYYY-MM-DD` with bullet entries.
3. Run the gates on a clean runner:
   ```bash
   pnpm install --no-frozen-lockfile
   pnpm run typecheck
   node --no-warnings --experimental-strip-types --loader ./tests/pi-peer-loader.mjs --test tests/*.test.ts
   pnpm run check:pack && pnpm run check:source-size && pnpm run check:release
   ```
   (CI already enforces typecheck + the orchestra layer + the substrate suite on every push.)
4. Commit the release files; ensure `git status --porcelain` is empty (a `check:release` gate).
5. Publish:
   ```bash
   npm publish        # or the pi.dev publish flow once available
   ```
6. Tag the release and push the tag.

## What CI already guarantees (the public test matrix)

| Gate (CI, required) | Covers |
| --- | --- |
| Typecheck | whole repo, 0 errors |
| hb-orchestra layer | `tests/orchestra-*.test.ts` incl. the API-contract guard (`docs/API.md`) |
| Inherited substrate suite | `tests/*.test.ts` minus the orchestra layer |

See `.github/workflows/ci.yml`. The API contract is machine-guarded by
`tests/orchestra-api-contract.test.ts`.
