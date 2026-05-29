/** Layer 4 (b): apply a harness contract to a run graph (read-only governance enforcement).
 *
 * Two effects, applied at Agent/Profile build time (NOT on replay, so a replayed graph re-runs
 * exactly as stored and its run_hash stays stable):
 *   1. mutation gate — if the contract sets mutationAllowed=false and the run requests mutation
 *      (edit/write tools, a mutationScope, or worktree isolation), the run is blocked.
 *   2. system-prompt injection — the text of the contract's systemPromptFiles is appended to each
 *      inline step's system prompt. Because computeRunHash hashes step system prompts, the harness
 *      influence is naturally folded into the reproducibility fingerprint (no separate hash needed).
 *
 * ARCHITECTURE I6: reads harness files; never writes them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GraphSpecInput } from "../../../multiagent/src/types.ts";
import { findHarnessContract } from "./contract-loader.ts";
import type { HarnessContract } from "./types.ts";

const MUTATION_TOOLS = new Set(["edit", "write"]);

export interface HarnessApplication {
	/** The effective graph to launch (possibly with injected system prompts). */
	graph: GraphSpecInput;
	blocked: boolean;
	reason?: string;
	contract?: HarnessContract;
	injectedSystemPrompt: boolean;
}

/** A run requests mutation if any step grants edit/write tools, declares a mutationScope, or isolates in a worktree. */
export function graphRequestsMutation(graph: GraphSpecInput): boolean {
	return graph.steps.some((step) => (step.agent.tools ?? []).some((tool) => MUTATION_TOOLS.has(tool)) || step.mutationScope !== undefined || step.isolation === "worktree");
}

/** Pure: apply a loaded contract (+ pre-read injection text) to a graph. */
export function applyContractToGraph(graph: GraphSpecInput, contract: HarnessContract, injectionText: string): HarnessApplication {
	if (contract.mutationAllowed === false && graphRequestsMutation(graph)) {
		return {
			graph,
			blocked: true,
			reason: `Harness contract (${contract.source}, ${contract.contractPath}) sets mutationAllowed=false, but this run requests mutation (edit/write tools, a mutationScope, or worktree isolation). Remove the mutation or update the contract.`,
			contract,
			injectedSystemPrompt: false,
		};
	}
	const trimmed = injectionText.trim();
	if (!trimmed) return { graph, blocked: false, contract, injectedSystemPrompt: false };
	const steps = graph.steps.map((step) =>
		step.agent.system !== undefined ? { ...step, agent: { ...step.agent, system: `${step.agent.system}\n\n--- Harness contract (${contract.source}) ---\n${trimmed}` } } : step,
	);
	const injectedSystemPrompt = steps.some((step, index) => step.agent.system !== graph.steps[index]?.agent.system);
	return { graph: { ...graph, steps }, blocked: false, contract, injectedSystemPrompt };
}

/** IO wrapper: discover the contract, read its systemPromptFiles (best-effort), and apply. */
export function applyHarnessContract(graph: GraphSpecInput, cwd: string): HarnessApplication {
	const lookup = findHarnessContract({ invocationCwd: cwd });
	if (!lookup.contract) return { graph, blocked: false, injectedSystemPrompt: false };
	return applyContractToGraph(graph, lookup.contract, readSystemPromptFiles(lookup.contract));
}

function readSystemPromptFiles(contract: HarnessContract): string {
	const parts: string[] = [];
	for (const relative of contract.systemPromptFiles ?? []) {
		try {
			const text = readFileSync(join(contract.sourceDir, relative), "utf8").trim();
			if (text) parts.push(text);
		} catch {
			/* best-effort: a missing/unreadable injected file is skipped, not fatal */
		}
	}
	return parts.join("\n\n");
}
