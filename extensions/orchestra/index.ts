/**
 * hb-orchestra extension entry-point.
 *
 * v0.5.0-pre, Layer 6 (compat-surface) minimal slice:
 *   - `Agent` tool: pi-subagents-compatible persona invocation by name.
 *   - `/agent <persona> <task>` slash command: operator convenience for the same.
 *
 * Both resolve a `.pi/agents/<name>.md` persona via Layer 1, map it to a single
 * inline-step detached graph via the Layer 6 pure mapper, and start it through
 * the inherited `agent_team` detached substrate. Detached by construction
 * (ARCHITECTURE I1): the call returns a run receipt with a runId immediately;
 * inspect/steer/cancel via the existing `agent_team` actions.
 *
 * Still deferred (later L6 increments): foreground inline-result waiting,
 * `get_subagent_result`, `steer_subagent`, `/profile`, and `Profile()`.
 * The inherited `agent_team` tool stays registered by `extensions/multiagent/index.ts`.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeLibraryOptions } from "../multiagent/src/agents.ts";
import { getParentSkillInventory } from "../multiagent/src/caller-skills.ts";
import { runAgentTeam } from "../multiagent/src/delegation.ts";
import { finalizeDetails, makeDetails, type AgentTeamRuntimeOptions } from "../multiagent/src/runtime-options.ts";
import { readSubagentSkillConfig, SUBAGENT_SKILLS_FLAG } from "../multiagent/src/subagent-skills-config.ts";
import type { AgentTeamDetails, ParentToolInfo, ParentToolInventory } from "../multiagent/src/types.ts";
import { findPersona } from "./src/agent-registry/index.ts";
import { agentInvocationToDetachedGraphStart, type AgentInvocation } from "./src/compat-surface/index.ts";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packageAgentsDir = join(packageRoot, "agents");

const AgentToolSchema = Type.Object({
	subagent_type: Type.String({ description: "Persona key resolved from .pi/agents/<name>.md (project), .agents/agents/, user, or builtin." }),
	prompt: Type.String({ description: "Concrete task for the agent. Becomes the detached step's task." }),
	description: Type.Optional(Type.String({ description: "Optional short run objective/label. Defaults to a persona-derived objective." })),
	model: Type.Optional(Type.String({ description: "Optional model lane override (provider/model). Falls back to the persona's frontmatter model." })),
	thinking: Type.Optional(Type.String({ description: "Optional thinking lane: off | minimal | low | medium | high | xhigh | inherit. Falls back to the persona's frontmatter thinking." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Optional strict child tool allowlist. Falls back to the persona's frontmatter tools." })),
	mutationScope: Type.Optional(Type.String({ description: "Required when the effective tools include edit/write." })),
	isolation: Type.Optional(Type.Literal("worktree", { description: "Run the mutation-capable agent inside a per-step git worktree." })),
});

type AgentToolParams = Static<typeof AgentToolSchema>;

/** Register the hb-orchestra Layer 6 compat surface (Agent tool + /agent command). */
export default function orchestraExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: [
			"Run a named .pi/agents persona as a detached child agent (hb-orchestra).",
			"Resolves the persona (model + thinking + tools + system prompt) by subagent_type, maps it to a single-step detached agent_team run, and returns a run receipt with a runId immediately.",
			"Inspect, steer, or cancel the run with the agent_team tool (run_status / step_result / message / cancel). Child output is untrusted, artifact-first evidence.",
		].join(" "),
		promptSnippet: "Run a .pi/agents persona by name as a detached agent; inspect via agent_team run_status.",
		parameters: AgentToolSchema,
		async execute(_toolCallId, params: AgentToolParams, signal, onUpdate, ctx) {
			return startPersonaRun(pi, ctx, toInvocation(params), signal, onUpdate);
		},
	});

	pi.registerCommand("agent", {
		description: "Run a .pi/agents persona by name as a detached agent: /agent <persona> <task>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstSpace = trimmed.search(/\s/);
			if (firstSpace < 0) {
				ctx.ui.notify("Usage: /agent <persona> <task>", "warning");
				return;
			}
			const subagent_type = trimmed.slice(0, firstSpace);
			const prompt = trimmed.slice(firstSpace + 1).trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /agent <persona> <task>", "warning");
				return;
			}
			const result = await startPersonaRun(pi, ctx, { subagent_type, prompt }, ctx.signal, undefined);
			const ok = result.details?.ok !== false;
			ctx.ui.notify(resultText(result), ok ? "info" : "error");
		},
	});
}

function toInvocation(params: AgentToolParams): AgentInvocation {
	return {
		subagent_type: params.subagent_type,
		prompt: params.prompt,
		description: params.description,
		model: params.model,
		thinking: params.thinking,
		tools: params.tools,
		mutationScope: params.mutationScope,
		isolation: params.isolation,
	};
}

/** Resolve persona -> map to detached single-step graph -> start via inherited agent_team substrate. */
async function startPersonaRun(pi: ExtensionAPI, ctx: ExtensionContext, invocation: AgentInvocation, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<AgentTeamDetails> | undefined): Promise<AgentToolResult<AgentTeamDetails>> {
	const options = buildRuntimeOptions(pi, ctx, signal, onUpdate);
	const lookup = findPersona(invocation.subagent_type, { invocationCwd: ctx.cwd, userHomeDir: homedir(), builtinAgentDir: packageAgentsDir });
	if (!lookup.persona) {
		return errorResult(options, "agent-persona-not-found", `Agent persona not found: ${JSON.stringify(invocation.subagent_type)}.${lookup.diagnostic ? ` ${lookup.diagnostic}` : ""}`);
	}
	const mapped = agentInvocationToDetachedGraphStart(lookup.persona, invocation);
	if (!mapped.graph) {
		const first = mapped.diagnostics.find((item) => item.severity === "error");
		return errorResult(options, first?.code ?? "agent-invocation-invalid", first ? `${first.code}: ${first.message}` : "Agent invocation could not be mapped to a detached graph.");
	}
	return runAgentTeam({ action: "start", graph: mapped.graph }, options);
}

function buildRuntimeOptions(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<AgentTeamDetails> | undefined): AgentTeamRuntimeOptions {
	// The agent-team-subagent-skills flag is registered by the multiagent extension; orchestra's
	// separate ExtensionAPI cannot read it (getFlag returns undefined), and the readSubagentSkillConfig
	// default is "enabled" which propagates every caller skill and trips MAX_CALLER_SKILLS. Default the
	// compat surface to "disabled" (pi-subagents semantics: children do not inherit caller skills) while
	// still honoring the operator flag if it is readable.
	const subagentSkills = readSubagentSkillConfig(pi.getFlag(SUBAGENT_SKILLS_FLAG) ?? "disabled");
	return {
		cwd: ctx.cwd,
		packageAgentsDir,
		materializationDiagnostics: subagentSkills.diagnostics,
		catalogLibrary: normalizeLibraryOptions(undefined),
		catalogPreparationDiagnostics: [],
		sessionId: ctx.sessionManager.getSessionId(),
		defaults: { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel() },
		parentTools: getParentToolInventory(pi),
		parentSkills: getParentSkillInventory(pi),
		subagentSkills: subagentSkills.config,
		signal,
		onUpdate,
		emitLifecycleEvent: (eventName, payload) => {
			try {
				pi.events?.emit?.(eventName, payload);
			} catch {
				/* best-effort */
			}
		},
	};
}

function errorResult(options: AgentTeamRuntimeOptions, code: string, message: string): AgentToolResult<AgentTeamDetails> {
	return finalizeDetails(makeDetails("start", false, [{ code, message, severity: "error" }], options, {}, { code, message }));
}

function resultText(result: AgentToolResult<AgentTeamDetails>): string {
	const text = result.content?.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim();
	return text && text.length > 0 ? text : "agent run started";
}

/** Mirror of multiagent/index.ts parent tool inventory reader (kept local to avoid a private import). */
function getParentToolInventory(pi: ExtensionAPI): ParentToolInventory {
	try {
		const activeNames = new Set(pi.getActiveTools());
		const tools: ParentToolInfo[] = pi.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			sourceInfo: { path: tool.sourceInfo.path, source: tool.sourceInfo.source, scope: tool.sourceInfo.scope, origin: tool.sourceInfo.origin, baseDir: tool.sourceInfo.baseDir },
			active: activeNames.has(tool.name),
		}));
		return { apiAvailable: true, errorMessage: undefined, tools };
	} catch (error) {
		return { apiAvailable: false, errorMessage: `Could not read parent Pi tool inventory: ${error instanceof Error ? error.message : String(error)}`, tools: [] };
	}
}
