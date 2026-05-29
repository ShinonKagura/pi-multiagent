/** Layer 5: Reproducibility Ledger — public exports.
 *
 * v0.5 core: deterministic `run_hash` over composed run inputs + a serializable replay manifest.
 * On-disk replay.json persistence and `/agent replay <run_id>` re-execution are a later increment.
 */

export type { ComposedRunInputs, ReplayManifest, RunHashStepInput } from "./types.ts";
export { canonicalJson, composedInputsFromGraph, computeRunHash, RUN_HASH_VERSION } from "./run-hash.ts";
export { buildReplayManifest } from "./replay-manifest.ts";
