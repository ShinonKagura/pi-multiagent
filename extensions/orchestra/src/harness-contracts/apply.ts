/** Layer 4 (b): apply a harness contract to a run graph (read-only governance enforcement).
 *
 * Effects, applied at Agent/Profile build time (NOT on replay, so a replayed graph re-runs exactly as
 * stored and its run_hash stays stable):
 *   1. mutation gate — if the contract sets mutationAllowed=false and the run requests mutation
 *      (edit/write tools, a mutationScope, or worktree isolation), the run is blocked.
 *   2. forbidden-path gate — if the contract declares forbiddenPaths and a mutating step's declared
 *      mutationScope targets one of them, the run is blocked at planning time.
 *   3. governance injection — the text of the contract's systemPromptFiles PLUS a generated path/scope
 *      policy block (allowedPaths/forbiddenPaths/mutationScope/externalSideEffects) is appended to each
 *      inline step's system prompt. Because computeRunHash hashes step system prompts, the harness
 *      influence is naturally folded into the reproducibility fingerprint.
 *
 * Honest scope: this is project-governance enforcement at planning + prompt-injection tiers, NOT an
 * OS-level path sandbox. The forbidden-path gate is a planning-time check of the caller's DECLARED
 * mutationScope against the contract; the injected policy reaches the child as explicit instruction.
 * Hard OS confinement of mutation remains worktree isolation's job.
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

function normalizePath(path: string): string {
	return path.trim().replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

/** Heuristic planning-time check: does any mutating step's declared mutationScope target a forbidden path?
 * (Substring match of a normalized forbidden path token within the free-text mutationScope.) */
export function forbiddenPathViolation(graph: GraphSpecInput, contract: HarnessContract): { stepId: string; path: string } | undefined {
	const forbidden = (contract.forbiddenPaths ?? []).map(normalizePath).filter((path) => path.length > 0);
	if (forbidden.length === 0) return undefined;
	for (const step of graph.steps) {
		if (step.mutationScope === undefined) continue;
		const scope = step.mutationScope.toLowerCase();
		for (const path of forbidden) if (scope.includes(path)) return { stepId: step.id, path };
	}
	return undefined;
}

/** Generated, child-facing governance block from the contract's path/scope/side-effect fields. */
export function buildHarnessPolicyText(contract: HarnessContract): string {
	const lines: string[] = [];
	if (contract.allowedPaths?.length) lines.push(`Allowed paths (only read/edit/write within these): ${contract.allowedPaths.join(", ")}`);
	if (contract.forbiddenPaths?.length) lines.push(`Forbidden paths (never read, edit, or write): ${contract.forbiddenPaths.join(", ")}`);
	if (contract.mutationScope) lines.push(`Mutation scope: ${contract.mutationScope}`);
	if (contract.externalSideEffectsAllowed === false) lines.push("External side effects (network calls, sending messages/email, etc.) are NOT permitted.");
	return lines.length === 0 ? "" : `Harness path & scope policy (project governance):\n${lines.map((line) => `- ${line}`).join("\n")}`;
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
	const violation = forbiddenPathViolation(graph, contract);
	if (violation) {
		return {
			graph,
			blocked: true,
			reason: `Harness contract (${contract.source}, ${contract.contractPath}) forbids path "${violation.path}", but step "${violation.stepId}" declares a mutationScope that targets it. Narrow the mutationScope or update the contract.`,
			contract,
			injectedSystemPrompt: false,
		};
	}
	const policyText = buildHarnessPolicyText(contract);
	const trimmed = [injectionText.trim(), policyText].filter((part) => part.length > 0).join("\n\n");
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
