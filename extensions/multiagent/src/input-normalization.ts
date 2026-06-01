/** Compatibility normalization for common agent-authored agent_team input mistakes. */

import type { AgentDiagnostic } from "./types.ts";

const STEP_AGENT_COMPAT_FIELDS = ["model", "fallbackModels", "thinking"] as const;
const OUTER_GRAPH_MERGE_FIELDS = ["library", "authority", "limits"] as const;

type StepAgentCompatField = (typeof STEP_AGENT_COMPAT_FIELDS)[number];

export interface NormalizedAgentTeamInput {
	input: unknown;
	diagnostics: AgentDiagnostic[];
}

/**
 * Normalize narrowly-scoped mistakes that agents repeatedly make despite the
 * public schema: a double-nested start graph and per-step model controls placed
 * next to `agent` rather than inside it. Ambiguous conflicts still fail closed.
 */
export function normalizeAgentTeamInput(rawInput: unknown): NormalizedAgentTeamInput {
	if (!isRecord(rawInput) || rawInput.action !== "start") return { input: rawInput, diagnostics: [] };
	const diagnostics: AgentDiagnostic[] = [];
	let input: Record<string, unknown> = rawInput;
	const nested = normalizeDoubleNestedGraph(input, diagnostics);
	if (nested !== input) input = nested;
	const agentFields = normalizeStepAgentFields(input, diagnostics);
	if (agentFields !== input) input = agentFields;
	return { input, diagnostics };
}

function normalizeDoubleNestedGraph(input: Record<string, unknown>, diagnostics: AgentDiagnostic[]): Record<string, unknown> {
	const graph = input.graph;
	if (!isRecord(graph) || !isRecord(graph.graph)) return input;
	const innerGraph = graph.graph;
	const outerHasBody = graph.objective !== undefined || graph.steps !== undefined;
	const innerHasBody = innerGraph.objective !== undefined || innerGraph.steps !== undefined;
	if (!innerHasBody || outerHasBody) return input;
	const nextGraph: Record<string, unknown> = { ...innerGraph };
	for (const field of OUTER_GRAPH_MERGE_FIELDS) {
		if (nextGraph[field] === undefined && graph[field] !== undefined) nextGraph[field] = graph[field];
	}
	diagnostics.push({
		code: "start-graph-double-nested-normalized",
		message: "Normalized graph.graph into graph for a start request; future calls should pass the pure graph directly under graph.",
		path: "/graph/graph",
		severity: "warning",
		repair: 'Use {"action":"start","graph":{"authority":{"allowFilesystemRead":true},"objective":"...","steps":[...]}}; do not nest the graph body under graph.graph.',
	});
	return { ...input, graph: nextGraph };
}

function normalizeStepAgentFields(input: Record<string, unknown>, diagnostics: AgentDiagnostic[]): Record<string, unknown> {
	const graph = input.graph;
	if (!isRecord(graph) || !Array.isArray(graph.steps)) return input;
	let changed = false;
	const steps = graph.steps.map((step, index) => {
		if (!isRecord(step) || !isRecord(step.agent)) return step;
		let nextStep: Record<string, unknown> | undefined;
		let nextAgent: Record<string, unknown> | undefined;
		const moved: StepAgentCompatField[] = [];
		for (const field of STEP_AGENT_COMPAT_FIELDS) {
			if (step[field] === undefined) continue;
			if (step.agent[field] !== undefined && !sameJsonValue(step.agent[field], step[field])) {
				diagnostics.push({
					code: "step-agent-field-conflict",
					message: `Step ${step.id ?? index} sets both ${field} and agent.${field} with different values; keeping both would be ambiguous.`,
					path: `/graph/steps/${index}/${field}`,
					severity: "error",
					repair: `Remove the step-level ${field}; keep the single intended value under steps[].agent.${field}.`,
				});
				continue;
			}
			nextStep ??= { ...step };
			nextAgent ??= { ...step.agent };
			delete nextStep[field];
			if (nextAgent[field] === undefined) nextAgent[field] = step[field];
			moved.push(field);
		}
		if (moved.length === 0 || !nextStep || !nextAgent) return step;
		nextStep.agent = nextAgent;
		changed = true;
		diagnostics.push({
			code: "step-agent-fields-normalized",
			message: `Moved step-level ${moved.join(", ")} into steps[].agent for step ${step.id ?? index}.`,
			path: `/graph/steps/${index}/agent`,
			severity: "warning",
			repair: "Place model, fallbackModels, and thinking under steps[].agent; step-level placement is compatibility-normalized only when unambiguous.",
		});
		return nextStep;
	});
	if (!changed) return input;
	return { ...input, graph: { ...graph, steps } };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
