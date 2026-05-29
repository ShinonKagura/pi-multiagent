/** Layer 3: Execution Runtime — profile to detached graph mapping.
 *
 * Builds pure `agent_team` start graph inputs from Layer 2 resolved profiles.
 * The result is detached by construction: callers pass the returned graph to the
 * inherited `agent_team` start action instead of blocking the parent session on
 * child compute.
 */

import type { GraphAuthority, GraphSpecInput, GraphStepAgentInput, GraphStepInput, TeamLimits, ThinkingLevel } from "../../../multiagent/src/types.ts";
import type { ProfileDiagnostic, ResolvedProfile, ResolvedProfileAgent } from "../profile-engine/types.ts";
import type { ProfileDetachedGraphOptions, ProfileDetachedGraphResult } from "./types.ts";

const MAX_CONCURRENCY = 6;
const GRAPH_THINKING_VALUES = new Set<ThinkingLevel>(["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]);

export function profileToDetachedGraphStart(profile: ResolvedProfile, options: ProfileDetachedGraphOptions): ProfileDetachedGraphResult {
	const diagnostics = validateGraphOptions(profile, options);
	if (diagnostics.some((item) => item.severity === "error")) return { action: "start", graph: undefined, diagnostics, profile };

	const steps = buildSteps(profile, options);
	const graph: GraphSpecInput = {
		objective: options.objective.trim(),
		authority: inferAuthority(profile, options),
		steps,
		limits: inferLimits(profile, options),
	};
	return { action: "start", graph, diagnostics, profile };
}

function validateGraphOptions(profile: ResolvedProfile, options: ProfileDetachedGraphOptions): ProfileDiagnostic[] {
	const diagnostics: ProfileDiagnostic[] = [...profile.diagnostics];
	if (!options.objective.trim()) diagnostics.push(makeDiagnostic("profile-graph-objective-required", "Detached profile graph objective must contain non-whitespace text."));
	if (!options.task.trim()) diagnostics.push(makeDiagnostic("profile-graph-task-required", "Detached profile graph task must contain non-whitespace text."));
	if (profile.unresolvedAgents.length > 0) diagnostics.push(makeDiagnostic("profile-graph-unresolved-agents", "Cannot build detached profile graph while profile agents are unresolved."));
	if (profile.agents.length === 0) diagnostics.push(makeDiagnostic("profile-graph-no-agents", "Cannot build detached profile graph without at least one resolved profile agent."));
	if (usesMutationTools(profile) && !options.mutationScope?.trim()) diagnostics.push(makeDiagnostic("profile-graph-mutation-scope-required", "Profile agents with edit/write tools require a concrete mutationScope before graph execution."));
	for (const agent of profile.agents) {
		if (agent.thinking !== undefined && !GRAPH_THINKING_VALUES.has(agent.thinking as ThinkingLevel)) diagnostics.push(makeDiagnostic("profile-graph-thinking-invalid", `Profile agent ${JSON.stringify(agent.subagent_type)} has invalid thinking value ${JSON.stringify(agent.thinking)}.`));
	}
	return diagnostics;
}

function buildSteps(profile: ResolvedProfile, options: ProfileDetachedGraphOptions): GraphStepInput[] {
	const usedIds = new Set<string>();
	let previousStepId: string | undefined;
	return profile.agents.map((agent) => {
		const id = uniqueStepId(agent.subagent_type, usedIds);
		const step: GraphStepInput = {
			id,
			agent: stripUndefinedAgent({
				system: agent.systemPrompt,
				tools: agent.tools,
				model: agent.model,
				thinking: agent.thinking as ThinkingLevel | undefined,
			}),
			task: options.task.trim(),
			mutationScope: options.mutationScope,
			cwd: options.cwd,
			isolation: options.isolation,
			worktreeSetup: options.worktreeSetup,
			outputLimit: options.outputLimit,
		};
		if (profile.kind === "chain" && previousStepId) step.needs = [previousStepId];
		previousStepId = id;
		return stripUndefinedStep(step);
	});
}

function inferAuthority(profile: ResolvedProfile, options: ProfileDetachedGraphOptions): Partial<GraphAuthority> {
	const tools = allRequestedTools(profile);
	return {
		allowFilesystemRead: true,
		allowShellTools: tools.has("bash"),
		allowMutationTools: tools.has("edit") || tools.has("write"),
		allowMutationWorktree: options.isolation === "worktree",
	};
}

function inferLimits(profile: ResolvedProfile, options: ProfileDetachedGraphOptions): Partial<TeamLimits> {
	return {
		concurrency: options.limits?.concurrency ?? (profile.kind === "chain" ? 1 : Math.min(Math.max(profile.agents.length, 1), MAX_CONCURRENCY)),
		timeoutSecondsPerStep: options.limits?.timeoutSecondsPerStep,
	};
}

function usesMutationTools(profile: ResolvedProfile): boolean {
	const tools = allRequestedTools(profile);
	return tools.has("edit") || tools.has("write");
}

function allRequestedTools(profile: ResolvedProfile): Set<string> {
	const tools = new Set<string>(["read"]);
	for (const agent of profile.agents) for (const tool of agent.tools ?? []) tools.add(tool);
	return tools;
}

function uniqueStepId(name: string, usedIds: Set<string>): string {
	const base = publicIdBase(name);
	let candidate = base;
	let suffix = 2;
	while (usedIds.has(candidate)) {
		const suffixText = `-${suffix}`;
		candidate = `${base.slice(0, 63 - suffixText.length)}${suffixText}`;
		suffix += 1;
	}
	usedIds.add(candidate);
	return candidate;
}

function publicIdBase(name: string): string {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const withLeadingLetter = /^[a-z]/.test(normalized) ? normalized : `step-${normalized || "agent"}`;
	return withLeadingLetter.slice(0, 63).replace(/-+$/g, "") || "step-agent";
}

function stripUndefinedStep(step: GraphStepInput): GraphStepInput {
	return Object.fromEntries(Object.entries(step).filter(([, value]) => value !== undefined)) as unknown as GraphStepInput;
}

function stripUndefinedAgent(agent: GraphStepAgentInput): GraphStepAgentInput {
	return Object.fromEntries(Object.entries(agent).filter(([, value]) => value !== undefined)) as unknown as GraphStepAgentInput;
}

function makeDiagnostic(code: string, message: string): ProfileDiagnostic {
	return { code, message, severity: "error" };
}
