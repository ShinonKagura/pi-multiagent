/** Layer 6: Compat Surface — `Agent()` invocation to detached graph mapping.
 *
 * Builds a single-step detached `agent_team` start graph from one resolved
 * Layer-1 persona plus pi-subagents-compatible invocation params. Detached by
 * construction: the caller passes the returned graph to the inherited
 * `agent_team` start action, so a foreground `/agent` wrapper never traps the
 * parent on child compute (ARCHITECTURE I1).
 */

import type { GraphAuthority, GraphSpecInput, GraphStepAgentInput, GraphStepInput, ThinkingLevel } from "../../../multiagent/src/types.ts";
import type { Persona } from "../agent-registry/types.ts";
import type { ProfileDiagnostic } from "../profile-engine/types.ts";
import type { AgentDetachedGraphResult, AgentInvocation } from "./types.ts";

const GRAPH_THINKING_VALUES = new Set<ThinkingLevel>(["inherit", "off", "minimal", "low", "medium", "high", "xhigh"]);

export function agentInvocationToDetachedGraphStart(persona: Persona, invocation: AgentInvocation): AgentDetachedGraphResult {
	const subagent_type = invocation.subagent_type;
	const tools = invocation.tools ?? copyList(persona.frontmatter.tools);
	const model = invocation.model ?? persona.frontmatter.model;
	const thinking = invocation.thinking ?? persona.frontmatter.thinking;

	const diagnostics = validate(invocation, tools, thinking);
	if (diagnostics.some((item) => item.severity === "error")) return { action: "start", graph: undefined, diagnostics, subagent_type };

	const step: GraphStepInput = {
		id: publicIdBase(persona.frontmatter.name || subagent_type),
		// v0.5 minimal: the child launches clean (no project SYSTEM.md), so the
		// persona body is used as the child's system prompt directly. systemPromptMode
		// append/replace composition against a parent prompt is a later L6 increment.
		agent: stripUndefinedAgent({
			system: persona.systemPrompt,
			tools,
			model,
			thinking: thinking as ThinkingLevel | undefined,
		}),
		task: invocation.prompt.trim(),
		mutationScope: invocation.mutationScope,
		isolation: invocation.isolation,
	};

	const graph: GraphSpecInput = {
		objective: objectiveFor(invocation, subagent_type),
		authority: inferAuthority(tools, invocation),
		steps: [stripUndefinedStep(step)],
	};
	return { action: "start", graph, diagnostics, subagent_type };
}

function validate(invocation: AgentInvocation, tools: string[] | undefined, thinking: string | undefined): ProfileDiagnostic[] {
	const diagnostics: ProfileDiagnostic[] = [];
	if (!invocation.subagent_type.trim()) diagnostics.push(makeDiagnostic("agent-subagent-type-required", "Agent() invocation requires a non-empty subagent_type."));
	if (!invocation.prompt.trim()) diagnostics.push(makeDiagnostic("agent-prompt-required", "Agent() invocation requires a non-empty prompt."));
	if (thinking !== undefined && !GRAPH_THINKING_VALUES.has(thinking as ThinkingLevel)) diagnostics.push(makeDiagnostic("agent-thinking-invalid", `Agent() invocation has invalid thinking value ${JSON.stringify(thinking)}.`));
	if (usesMutationTools(tools) && !invocation.mutationScope?.trim()) diagnostics.push(makeDiagnostic("agent-mutation-scope-required", "Agent() invocations whose tools include edit/write require a concrete mutationScope."));
	return diagnostics;
}

function objectiveFor(invocation: AgentInvocation, subagent_type: string): string {
	const description = invocation.description?.trim();
	if (description) return description;
	return `Agent ${subagent_type}`;
}

function inferAuthority(tools: string[] | undefined, invocation: AgentInvocation): Partial<GraphAuthority> {
	const set = new Set<string>(["read", ...(tools ?? [])]);
	return {
		allowFilesystemRead: true,
		allowShellTools: set.has("bash"),
		allowMutationTools: set.has("edit") || set.has("write"),
		allowMutationWorktree: invocation.isolation === "worktree",
	};
}

function usesMutationTools(tools: string[] | undefined): boolean {
	if (!tools) return false;
	return tools.includes("edit") || tools.includes("write");
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

function copyList(value: string[] | undefined): string[] | undefined {
	return value ? [...value] : undefined;
}

function makeDiagnostic(code: string, message: string): ProfileDiagnostic {
	return { code, message, severity: "error" };
}
