/**
 * hb-orchestra extension entry-point.
 *
 * v0.5.0-pre, Layer 6 (compat-surface) minimal slice:
 *   - `Agent` tool: pi-subagents-compatible persona invocation by name.
 *   - `/agent <persona> <task>` slash command: operator convenience for the same.
 *   - `Profile` tool + `/profile <profile> <task>`: run a saved `.pi/profiles` chain/parallel
 *     workflow (Layer 2 resolve + Layer 1 personas -> Layer 3 detached graph).
 *   - `get_subagent_result` / `steer_subagent`: pi-subagents-compatible wrappers over the
 *     inherited `agent_team` run_status / message actions for a detached run by runId.
 *   - Optional `waitSeconds` on `Agent`/`Profile`: bounded foreground wait that returns the
 *     finished result inline, still returning the runId on timeout (ARCHITECTURE I1: never blocks
 *     the parent indefinitely).
 *   - `/harness`: read-only discovery of an optional project/workspace harness contract (Layer 4;
 *     ARCHITECTURE I6 — reads `.pi/harness/` or `.agents/harness/`, never writes). When present, the
 *     contract is enforced on `Agent`/`Profile` runs: systemPromptFiles are injected into step prompts
 *     and a `mutationAllowed:false` contract blocks runs that request edit/write.
 *   - run_hash on each `Agent`/`Profile` start: a deterministic reproducibility fingerprint over the
 *     composed inputs, emitted as a `hb-orchestra:run-hash` event and appended to the start result (Layer 5).
 *   - `Replay` tool + `/replay <run_hash|runId>`: re-execute a prior run from the persisted replay
 *     ledger (keyed by stable run_hash); the replay's run_hash matches the original (Layer 5).
 *
 * Both resolve a `.pi/agents/<name>.md` persona via Layer 1, map it to a single
 * inline-step detached graph via the Layer 6 pure mapper, and start it through
 * the inherited `agent_team` detached substrate. Detached by construction
 * (ARCHITECTURE I1): the call returns a run receipt with a runId immediately;
 * inspect/steer/cancel via the existing `agent_team` actions.
 *
 * L6 compat surface is feature-complete for v0.5 (Agent/Profile tools + /agent//profile commands
 * + get_subagent_result/steer_subagent + bounded foreground wait).
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
import type { AgentTeamDetails, GraphSpecInput, ParentToolInfo, ParentToolInventory } from "../multiagent/src/types.ts";
import { findPersona } from "./src/agent-registry/index.ts";
import { agentInvocationToDetachedGraphStart, type AgentInvocation } from "./src/compat-surface/index.ts";
import { profileToDetachedGraphStart } from "./src/execution-runtime/index.ts";
import { applyHarnessContract, findHarnessContract, summarizeHarnessContract } from "./src/harness-contracts/index.ts";
import { findProfile, resolveProfile } from "./src/profile-engine/index.ts";
import { buildReplayManifest, composedInputsFromGraph, computeRunHash, loadReplayManifest, writeReplayManifest } from "./src/reproducibility-ledger/index.ts";

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
	waitSeconds: Type.Optional(Type.Number({ description: "Foreground wait: block up to N seconds (bounded, capped at 600) polling for the run to finish and return its result inline. Omit for detached (returns a runId immediately). On timeout the result still carries the runId for get_subagent_result.", minimum: 1, maximum: 600, multipleOf: 1 })),
});

type AgentToolParams = Static<typeof AgentToolSchema>;

const ProfileToolSchema = Type.Object({
	profile: Type.String({ description: "Profile key resolved from .pi/profiles/<name>.{json|md} (project)." }),
	task: Type.String({ description: "Concrete task delegated to each profile member. Becomes every generated step's task." }),
	description: Type.Optional(Type.String({ description: "Optional run objective/label. Defaults to a profile-derived objective." })),
	mutationScope: Type.Optional(Type.String({ description: "Required when any profile member's effective tools include edit/write." })),
	isolation: Type.Optional(Type.Literal("worktree", { description: "Run mutation-capable members inside a per-step git worktree." })),
	waitSeconds: Type.Optional(Type.Number({ description: "Foreground wait: block up to N seconds (bounded, capped at 600) polling for the run to finish and return its result inline. Omit for detached (returns a runId immediately). On timeout the result still carries the runId for get_subagent_result.", minimum: 1, maximum: 600, multipleOf: 1 })),
});

type ProfileToolParams = Static<typeof ProfileToolSchema>;

interface ProfileInvocation {
	profile: string;
	task: string;
	description?: string;
	mutationScope?: string;
	isolation?: "worktree";
}

const RUN_ID = Type.String({ description: "Short process-local runId returned by Agent / Profile / agent_team start.", minLength: 2, maxLength: 8 });

const GetSubagentResultSchema = Type.Object({
	runId: RUN_ID,
	waitSeconds: Type.Optional(Type.Number({ description: "Optionally block up to N seconds for a material event / terminal state before returning (run-level only; ignored when stepId is set).", minimum: 1, maximum: 60, multipleOf: 1 })),
	stepId: Type.Optional(Type.String({ description: "Inspect one specific step's full output (step_result) instead of the run-level sink outputs (run_status)." })),
	maxBytes: Type.Optional(Type.Number({ description: "Cap on returned assistant preview bytes.", minimum: 1, multipleOf: 1 })),
});

type GetSubagentResultParams = Static<typeof GetSubagentResultSchema>;

const SteerSubagentSchema = Type.Object({
	runId: RUN_ID,
	message: Type.String({ description: "Steering / clarification text for the running child. Bounded scope repair, not post-terminal chat.", minLength: 1 }),
	stepId: Type.Optional(Type.String({ description: "Target step. Omit when the run has exactly one live step (auto-resolved)." })),
	channel: Type.Optional(Type.String({ description: 'Delivery channel: "steer" (default, queues before next LLM call) or "follow_up" (defers until quiescent).' })),
});

type SteerSubagentParams = Static<typeof SteerSubagentSchema>;

const ReplayToolSchema = Type.Object({
	runId: Type.String({ description: "The run_hash (preferred, stable across processes) or a recent runId of a prior run to re-execute. The run_hash is in a run's start result (run_hash=...).", minLength: 2 }),
	waitSeconds: Type.Optional(Type.Number({ description: "Foreground wait (1-600, bounded) for the replayed run; omit for detached (returns a runId).", minimum: 1, maximum: 600, multipleOf: 1 })),
});

type ReplayToolParams = Static<typeof ReplayToolSchema>;

/** Resolve which step a steer message targets. Pure so it is unit-testable. */
export function resolveSteerStepId(liveStepIds: string[], providedStepId: string | undefined): { stepId?: string; error?: { code: string; message: string } } {
	if (providedStepId) return { stepId: providedStepId };
	if (liveStepIds.length === 1) return { stepId: liveStepIds[0] };
	if (liveStepIds.length === 0) return { error: { code: "steer-no-live-step", message: "Run has no live step to steer (it may be terminal); nothing to message." } };
	return { error: { code: "steer-ambiguous-step", message: `Run has multiple live steps [${liveStepIds.join(", ")}]; pass an explicit stepId.` } };
}

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
			return startPersonaRun(pi, ctx, toInvocation(params), signal, onUpdate, params.waitSeconds);
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

	pi.registerTool({
		name: "Profile",
		label: "Profile",
		description: [
			"Run a named .pi/profiles workflow (a chain or parallel set of personas) as a detached agent_team run (hb-orchestra).",
			"Resolves the profile (Layer 2) and its member personas (Layer 1), maps it to a detached chain/parallel graph (Layer 3), starts it on the inherited agent_team substrate, and returns a run receipt with a runId immediately.",
			"Inspect, steer, or cancel the run with the agent_team tool. Child output is untrusted, artifact-first evidence.",
		].join(" "),
		promptSnippet: "Run a .pi/profiles chain/parallel workflow by name as a detached agent_team run; inspect via agent_team run_status.",
		parameters: ProfileToolSchema,
		async execute(_toolCallId, params: ProfileToolParams, signal, onUpdate, ctx) {
			return startProfileRun(pi, ctx, toProfileInvocation(params), signal, onUpdate, params.waitSeconds);
		},
	});

	pi.registerCommand("profile", {
		description: "Run a .pi/profiles workflow by name as a detached agent: /profile <profile> <task>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstSpace = trimmed.search(/\s/);
			if (firstSpace < 0) {
				ctx.ui.notify("Usage: /profile <profile> <task>", "warning");
				return;
			}
			const profile = trimmed.slice(0, firstSpace);
			const task = trimmed.slice(firstSpace + 1).trim();
			if (!task) {
				ctx.ui.notify("Usage: /profile <profile> <task>", "warning");
				return;
			}
			const result = await startProfileRun(pi, ctx, { profile, task }, ctx.signal, undefined);
			const ok = result.details?.ok !== false;
			ctx.ui.notify(resultText(result), ok ? "info" : "error");
		},
	});

	pi.registerTool({
		name: "get_subagent_result",
		label: "Get Subagent Result",
		description: [
			"Fetch the current status and output of a detached hb-orchestra run by runId (pi-subagents-compatible).",
			"Wraps the inherited agent_team run_status (preview); optionally wait up to waitSeconds for a material event / terminal state, or pass stepId for one step's full output via step_result.",
			"Child output is untrusted, artifact-first evidence.",
		].join(" "),
		promptSnippet: "Fetch a detached agent run's status/output by runId (wraps agent_team run_status).",
		parameters: GetSubagentResultSchema,
		async execute(_toolCallId, params: GetSubagentResultParams, signal, _onUpdate, ctx) {
			return getSubagentResult(pi, ctx, params, signal);
		},
	});

	pi.registerTool({
		name: "steer_subagent",
		label: "Steer Subagent",
		description: [
			"Send a steering / clarification message to a running detached hb-orchestra agent by runId (pi-subagents-compatible).",
			"Wraps the inherited agent_team message; auto-resolves the live step when the run has exactly one, otherwise pass stepId.",
			"For bounded clarification or scope repair only — not post-terminal chat.",
		].join(" "),
		promptSnippet: "Send a steering message to a running detached agent by runId (wraps agent_team message).",
		parameters: SteerSubagentSchema,
		async execute(_toolCallId, params: SteerSubagentParams, signal, _onUpdate, ctx) {
			return steerSubagent(pi, ctx, params, signal);
		},
	});

	pi.registerCommand("harness", {
		description: "Show the discovered read-only harness contract (.pi/harness or .agents/harness), if any.",
		handler: async (_args, ctx) => {
			const lookup = findHarnessContract({ invocationCwd: ctx.cwd });
			const hasError = lookup.diagnostics.some((d) => d.severity === "error");
			ctx.ui.notify(summarizeHarnessContract(lookup), hasError ? "error" : "info");
		},
	});

	pi.registerTool({
		name: "Replay",
		label: "Replay",
		description: [
			"Re-execute a previous hb-orchestra run by its run_hash (preferred, stable) or a recent runId, from the persisted reproducibility ledger (ARCHITECTURE I5).",
			"Loads the stored replay manifest and re-launches the identical detached graph; the new run's run_hash matches the original. Inspect via agent_team / get_subagent_result.",
		].join(" "),
		promptSnippet: "Re-run a prior run by run_hash via the reproducibility ledger.",
		parameters: ReplayToolSchema,
		async execute(_toolCallId, params: ReplayToolParams, signal, onUpdate, ctx) {
			return startReplay(pi, ctx, params.runId, signal, onUpdate, params.waitSeconds);
		},
	});

	pi.registerCommand("replay", {
		description: "Re-run a previous run by run_hash (or recent runId): /replay <run_hash|runId>",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /replay <run_hash|runId>", "warning");
				return;
			}
			const result = await startReplay(pi, ctx, id, ctx.signal, undefined);
			const ok = result.details?.ok !== false;
			ctx.ui.notify(resultText(result), ok ? "info" : "error");
		},
	});
}

function toProfileInvocation(params: ProfileToolParams): ProfileInvocation {
	return {
		profile: params.profile,
		task: params.task,
		description: params.description,
		mutationScope: params.mutationScope,
		isolation: params.isolation,
	};
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
async function startPersonaRun(pi: ExtensionAPI, ctx: ExtensionContext, invocation: AgentInvocation, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<AgentTeamDetails> | undefined, waitSeconds?: number): Promise<AgentToolResult<AgentTeamDetails>> {
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
	const harness = applyHarnessContract(mapped.graph, ctx.cwd);
	if (harness.blocked) return errorResult(options, "harness-mutation-denied", harness.reason ?? "Harness contract denied this run.");
	return startRunMaybeWait(options, harness.graph, waitSeconds);
}

/** Resolve profile (L2) + member personas (L1) -> map to detached chain/parallel graph (L3) -> start via inherited agent_team substrate. */
async function startProfileRun(pi: ExtensionAPI, ctx: ExtensionContext, invocation: ProfileInvocation, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<AgentTeamDetails> | undefined, waitSeconds?: number): Promise<AgentToolResult<AgentTeamDetails>> {
	const options = buildRuntimeOptions(pi, ctx, signal, onUpdate);
	const lookup = findProfile(invocation.profile, { invocationCwd: ctx.cwd });
	if (!lookup.profile) {
		return errorResult(options, "profile-not-found", `Profile not found: ${JSON.stringify(invocation.profile)}.${lookup.diagnostic ? ` ${lookup.diagnostic}` : ""}`);
	}
	const resolved = resolveProfile(lookup.profile, (subagentType) => findPersona(subagentType, { invocationCwd: ctx.cwd, userHomeDir: homedir(), builtinAgentDir: packageAgentsDir }).persona);
	const objective = invocation.description?.trim() || `Profile ${resolved.name}`;
	const mapped = profileToDetachedGraphStart(resolved, { objective, task: invocation.task, mutationScope: invocation.mutationScope, isolation: invocation.isolation });
	if (!mapped.graph) {
		const first = mapped.diagnostics.find((item) => item.severity === "error");
		return errorResult(options, first?.code ?? "profile-invocation-invalid", first ? `${first.code}: ${first.message}` : "Profile could not be mapped to a detached graph.");
	}
	const harness = applyHarnessContract(mapped.graph, ctx.cwd);
	if (harness.blocked) return errorResult(options, "harness-mutation-denied", harness.reason ?? "Harness contract denied this run.");
	return startRunMaybeWait(options, harness.graph, waitSeconds);
}

/** pi-subagents-compatible result fetch: wraps agent_team run_status (or step_result for one step). */
async function getSubagentResult(pi: ExtensionAPI, ctx: ExtensionContext, params: GetSubagentResultParams, signal: AbortSignal | undefined): Promise<AgentToolResult<AgentTeamDetails>> {
	const options = buildRuntimeOptions(pi, ctx, signal, undefined);
	if (params.stepId) {
		return runAgentTeam({ action: "step_result", runId: params.runId, stepId: params.stepId, preview: true, maxBytes: params.maxBytes }, options);
	}
	return runAgentTeam({ action: "run_status", runId: params.runId, waitSeconds: params.waitSeconds, preview: true, maxBytes: params.maxBytes }, options);
}

/** pi-subagents-compatible steer: wraps agent_team message, auto-resolving the live step. */
async function steerSubagent(pi: ExtensionAPI, ctx: ExtensionContext, params: SteerSubagentParams, signal: AbortSignal | undefined): Promise<AgentToolResult<AgentTeamDetails>> {
	const options = buildRuntimeOptions(pi, ctx, signal, undefined);
	let stepId = params.stepId;
	if (!stepId) {
		const status = await runAgentTeam({ action: "run_status", runId: params.runId }, options);
		if (status.details?.ok === false) return status;
		const resolution = resolveSteerStepId(status.details?.run?.liveStepIds ?? [], undefined);
		if (resolution.error) return errorResult(options, resolution.error.code, resolution.error.message);
		stepId = resolution.stepId;
	}
	const channel: "steer" | "follow_up" = params.channel === "follow_up" ? "follow_up" : "steer";
	return runAgentTeam({ action: "message", runId: params.runId, stepId, channel, text: params.message }, options);
}

const FOREGROUND_WAIT_CAP_SECONDS = 600;
const RUN_STATUS_WAIT_CHUNK_SECONDS = 30; // <= MAX_RUN_STATUS_WAIT_SECONDS (60)

/** Clamp a requested foreground wait to a bounded window. ARCHITECTURE I1: the foreground wrapper must
 * never trap the parent on hung child compute, so undefined/invalid -> no wait, and the cap is hard. */
export function clampForegroundWaitSeconds(waitSeconds: number | undefined): number | undefined {
	if (waitSeconds === undefined || !Number.isFinite(waitSeconds) || waitSeconds < 1) return undefined;
	return Math.min(Math.floor(waitSeconds), FOREGROUND_WAIT_CAP_SECONDS);
}

/** Start a detached run; when waitSeconds is set, bounded-poll run_status and return the (possibly
 * terminal) result inline. Always returns within the cap; on timeout the snapshot still carries the
 * runId so the parent can inspect later with get_subagent_result. */
async function startRunMaybeWait(options: AgentTeamRuntimeOptions, graph: GraphSpecInput, waitSeconds?: number): Promise<AgentToolResult<AgentTeamDetails>> {
	const started = await runAgentTeam({ action: "start", graph }, options);
	if (started.details?.ok === false) return started;
	// Layer 5: deterministic reproducibility fingerprint over the composed inputs we launched.
	const runHash = computeRunHash(composedInputsFromGraph(graph));
	const runId = started.details?.run?.runId;
	if (runId) {
		try {
			options.emitLifecycleEvent?.("hb-orchestra:run-hash", { runId, runHash });
		} catch {
			/* best-effort: reproducibility fingerprint is observability, never load-bearing */
		}
		try {
			writeReplayManifest(buildReplayManifest({ graph, runHash, createdAt: new Date().toISOString() }), runId);
		} catch {
			/* best-effort: the replay ledger is observability, never load-bearing */
		}
	}
	const cap = clampForegroundWaitSeconds(waitSeconds);
	if (cap === undefined || !runId || started.details?.run?.terminal === true) return appendRunHashNote(started, runHash);
	const deadline = Date.now() + cap * 1000;
	let last = started;
	while (Date.now() < deadline) {
		const remaining = Math.ceil((deadline - Date.now()) / 1000);
		const chunk = Math.max(1, Math.min(remaining, RUN_STATUS_WAIT_CHUNK_SECONDS));
		last = await runAgentTeam({ action: "run_status", runId, waitSeconds: chunk, preview: true }, options);
		if (last.details?.ok === false || last.details?.run?.terminal === true) break;
	}
	return appendRunHashNote(last, runHash);
}

export function appendRunHashNote(result: AgentToolResult<AgentTeamDetails>, runHash: string): AgentToolResult<AgentTeamDetails> {
	return { ...result, content: [...(result.content ?? []), { type: "text" as const, text: `[hb-orchestra] run_hash=${runHash}` }] };
}

/** Re-execute a prior run from the persisted replay ledger by run_hash (preferred) or recent runId. */
async function startReplay(pi: ExtensionAPI, ctx: ExtensionContext, idOrHash: string, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<AgentTeamDetails> | undefined, waitSeconds?: number): Promise<AgentToolResult<AgentTeamDetails>> {
	const options = buildRuntimeOptions(pi, ctx, signal, onUpdate);
	const loaded = loadReplayManifest(idOrHash);
	if (!loaded.manifest) {
		return errorResult(options, "replay-not-found", `Replay manifest not found for ${JSON.stringify(idOrHash)}.${loaded.diagnostic ? ` ${loaded.diagnostic}` : ""}`);
	}
	return startRunMaybeWait(options, loaded.manifest.graph, waitSeconds);
}

function buildRuntimeOptions(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<AgentTeamDetails> | undefined): AgentTeamRuntimeOptions {
	// Hard-default the compat surface to "disabled" (pi-subagents semantics: child agents do not inherit
	// caller skills). Rationale: readSubagentSkillConfig(undefined) defaults to "enabled", which propagates
	// every caller skill and trips MAX_CALLER_SKILLS, so /agent fails in any skill-rich session. Only
	// "disabled" short-circuits the cap (resolveAgentCallerSkills); "auto" and "enabled" both hard-error
	// over the cap in the resolveDetachedGraph path (there is no auto soft-fallback here).
	// KNOWN LIMITATION: the operator --agent-team-subagent-skills flag does NOT affect /agent. That flag
	// is registered by the multiagent extension and orchestra's separate ExtensionAPI returns undefined
	// from getFlag, so the value is never read here. The getFlag read is retained only so honoring the
	// flag becomes automatic IF orchestra later registers it itself (tracked as a follow-up).
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
	return finalizeDetails(makeDetails("start", false, [{ code, message, severity: "error", path: undefined }], options, {}, { code, message }));
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
