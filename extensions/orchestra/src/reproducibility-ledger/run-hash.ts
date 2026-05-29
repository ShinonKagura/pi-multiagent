/** Layer 5: Reproducibility Ledger — deterministic run hash.
 *
 * `computeRunHash` is a pure, order-stable sha256 over the composed run inputs, so two logically
 * identical runs produce the same fingerprint regardless of object key order (ARCHITECTURE I5).
 */

import { createHash } from "node:crypto";

import type { GraphSpecInput } from "../../../multiagent/src/types.ts";
import type { ComposedRunInputs, RunHashStepInput } from "./types.ts";

/** Bump when the hashed input shape changes so old and new hashes never collide silently. */
export const RUN_HASH_VERSION = "hb-orchestra-run-hash-v1";

export function computeRunHash(inputs: ComposedRunInputs): string {
	return createHash("sha256").update(canonicalJson({ version: RUN_HASH_VERSION, inputs })).digest("hex");
}

/** Derive the composed inputs from the detached graph hb-orchestra launches. */
export function composedInputsFromGraph(graph: GraphSpecInput, harnessContractHash?: string): ComposedRunInputs {
	const steps: RunHashStepInput[] = graph.steps.map((step) => {
		const out: RunHashStepInput = {
			id: step.id,
			agent: step.agent.system !== undefined ? step.agent.system : step.agent.ref !== undefined ? `ref:${step.agent.ref}` : "",
			task: step.task,
		};
		if (step.agent.tools !== undefined) out.tools = step.agent.tools;
		if (step.agent.model !== undefined) out.model = step.agent.model;
		if (step.agent.thinking !== undefined) out.thinking = step.agent.thinking;
		if (step.mutationScope !== undefined) out.mutationScope = step.mutationScope;
		return out;
	});
	const composed: ComposedRunInputs = { objective: graph.objective, steps };
	if (graph.authority !== undefined) composed.authority = graph.authority as Record<string, unknown>;
	if (harnessContractHash !== undefined) composed.harnessContractHash = harnessContractHash;
	return composed;
}

/** Stable JSON: object keys sorted recursively; array order preserved. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) sorted[key] = sortValue(source[key]);
		return sorted;
	}
	return value;
}
