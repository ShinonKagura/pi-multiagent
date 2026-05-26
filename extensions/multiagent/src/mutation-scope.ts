import type { GraphSpec } from "./schemas.ts";
import { MUTATION_CHILD_TOOL_NAMES, SHELL_CHILD_TOOL_NAMES } from "./types.ts";
import type { AgentDiagnostic, GraphAuthority, ResolvedAgent } from "./types.ts";

const MUTATION_SCOPE_TOOLS = new Set<string>(MUTATION_CHILD_TOOL_NAMES);
const WORKER_SCOPE_TOOLS = new Set<string>([...SHELL_CHILD_TOOL_NAMES, ...MUTATION_CHILD_TOOL_NAMES]);

/** A step is mutation-capable if it can edit/write, or if it is package:worker with bash. */
export function isMutationCapableStep(agent: ResolvedAgent): boolean {
	return agent.tools.some((tool) => MUTATION_SCOPE_TOOLS.has(tool)) || (agent.ref === "package:worker" && agent.tools.some((tool) => WORKER_SCOPE_TOOLS.has(tool)));
}

/** Planning-time validation for step.isolation:'worktree'. Requires graph authority and a mutation-capable step. */
export function validateStepIsolation(step: { isolation?: string }, agent: ResolvedAgent, authority: GraphAuthority, diagnostics: AgentDiagnostic[], path: string): { valid: boolean; value: "worktree" | undefined } {
	if (step.isolation === undefined) return { valid: true, value: undefined };
	if (step.isolation !== "worktree") {
		diagnostics.push({ code: "isolation-value-invalid", message: `Unknown step isolation value: ${String(step.isolation)}.`, severity: "error", path });
		return { valid: false, value: undefined };
	}
	if (!authority.allowMutationWorktree) {
		diagnostics.push({ code: "worktree-authority-required", message: "Step requests isolation:'worktree' but graph.authority.allowMutationWorktree is false. Set graph.authority.allowMutationWorktree:true to opt into per-step git worktree isolation for mutation-capable steps.", severity: "error", path });
		return { valid: false, value: undefined };
	}
	if (!isMutationCapableStep(agent)) {
		diagnostics.push({ code: "worktree-non-mutation-denied", message: "Step requests isolation:'worktree' but is not mutation-capable. Worktree isolation is only allowed for steps that use edit/write, or for package:worker steps that use bash. Remove isolation:'worktree' from read-only steps.", severity: "error", path });
		return { valid: false, value: undefined };
	}
	return { valid: true, value: "worktree" };
}

export function resolveMutationScope(step: GraphSpec["steps"][number], agent: ResolvedAgent, diagnostics: AgentDiagnostic[], path: string): { valid: boolean; value: string | undefined } {
	const scope = step.mutationScope?.trim();
	const required = agent.tools.some((tool) => MUTATION_SCOPE_TOOLS.has(tool)) || (agent.ref === "package:worker" && agent.tools.some((tool) => WORKER_SCOPE_TOOLS.has(tool)));
	if (!scope) {
		if (!required) return { valid: true, value: undefined };
		diagnostics.push({ code: "mutation-scope-required", message: "Steps with edit/write tools, or package:worker with bash, require concrete step mutationScope naming allowed files or mutation class. Use a read-only profile or package:validator when no mutation is authorized.", severity: "error", path });
		return { valid: false, value: undefined };
	}
	if (hasConcreteMutationScope(scope)) return { valid: true, value: scope };
	diagnostics.push({ code: "mutation-scope-invalid", message: "Step mutationScope must name a concrete allowed file set or mutation class; REPLACE/TODO/TBD placeholders, angle placeholders, ellipses, and vague placeholder text are denied.", severity: "error", path });
	return { valid: false, value: undefined };
}

function hasConcreteMutationScope(scope: string): boolean {
	if (scope.length < 8) return false;
	if (/^(?:REPLACE|TODO|TBD)(?:\b|[_-])/i.test(scope)) return false;
	if (/\bplaceholder\b/i.test(scope) || scope.includes("<") || scope.includes(">") || scope.includes("...")) return false;
	return true;
}
