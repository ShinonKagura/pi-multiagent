/** Layer 5: Reproducibility Ledger — types.
 *
 * v0.5 core: a deterministic reproducibility fingerprint (`run_hash`) over the composed run inputs
 * hb-orchestra actually launches, plus a serializable replay descriptor. ARCHITECTURE I5:
 * run_hash = sha256(system prompt + tools + model + task + objective + authority [+ harness]).
 *
 * Out of scope here (later increment): writing replay.json into the substrate run dir and a
 * `/agent replay <run_id>` re-execution command.
 */

import type { GraphSpecInput } from "../../../multiagent/src/types.ts";

export interface RunHashStepInput {
	id: string;
	/** Inline system-prompt text, or `ref:<library-ref>` for a library agent. */
	agent: string;
	task: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	mutationScope?: string;
}

export interface ComposedRunInputs {
	objective: string;
	steps: RunHashStepInput[];
	authority?: Record<string, unknown>;
	/** Optional fingerprint of the active harness contract (Layer 4), folded into the run hash. */
	harnessContractHash?: string;
}

export interface ReplayManifest {
	schemaVersion: 1;
	runHash: string;
	objective: string;
	/** Everything needed to re-launch the same detached run. */
	graph: GraphSpecInput;
	createdAt: string;
	harnessContractHash?: string;
}
