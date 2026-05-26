/** Shared detached-runtime result helpers and execution options. */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { SpawnProcess } from "./child-launch.ts";
import { formatDetailsForModelContent } from "./result-format.ts";
import { catalogParentExtensionTools } from "./tool-policy.ts";
import type { ScheduledRunRegistry } from "./scheduled-runs.ts";
import type { AgentDiagnostic, AgentInvocationDefaults, AgentTeamDetails, LibraryOptions, ParentSkillInventory, ParentToolInventory } from "./types.ts";
import type { SubagentSkillConfig } from "./subagent-skills-config.ts";

export interface AgentTeamRuntimeOptions {
	cwd: string;
	packageAgentsDir: string;
	materializationDiagnostics: AgentDiagnostic[];
	catalogLibrary: LibraryOptions;
	catalogPreparationDiagnostics: AgentDiagnostic[];
	/** Stable owner for process-local retained runs; follow-up actions only see runs from the same Pi session when available. */
	sessionId?: string;
	defaults: AgentInvocationDefaults;
	parentTools?: ParentToolInventory;
	parentSkills?: ParentSkillInventory;
	subagentSkills?: SubagentSkillConfig;
	signal: AbortSignal | undefined;
	/** Tool-call updates are action-scoped; detached background runs must not retain or call this after start returns. */
	onUpdate: AgentToolUpdateCallback<AgentTeamDetails> | undefined;
	onRunUpdate?: (details: AgentTeamDetails) => string | undefined;
	onRunNotice?: (details: AgentTeamDetails) => string | undefined;
	spawnProcess?: SpawnProcess;
	/** Internal test hook: shorten command-ack timeout for deterministic message-idempotency regressions. */
	rpcCommandAckTimeoutMs?: number;
	/**
	 * G4: lifecycle event emitter. Wired from `index.ts` to `pi.events.emit`. Called from
	 * `DetachedRun` to notify cross-extension consumers of run/step lifecycle transitions.
	 * No-op if absent; events are best-effort and never block the run.
	 */
	emitLifecycleEvent?: (eventName: string, payload: Record<string, unknown>) => void;
	/** NEU-C: shared in-process schedule registry for `start`/`list`/`cancel` routing. */
	scheduledRunRegistry?: ScheduledRunRegistry;
}

export function makeDetails(action: AgentTeamDetails["action"], ok: boolean, diagnostics: AgentDiagnostic[], options: AgentTeamRuntimeOptions, data: Partial<AgentTeamDetails> = {}, error?: { code: string; message: string }): AgentTeamDetails {
	const firstError = diagnostics.find((item) => item.severity === "error");
	const materializedError = error ?? (firstError ? { code: firstError.code, message: firstError.message } : undefined);
	return { kind: "agent_team", action, ok: ok && firstError === undefined && materializedError === undefined, diagnostics: diagnostics.map((item) => ({ ...item, fields: item.fields ? [...item.fields] : undefined })), error: materializedError, library: data.library, catalog: data.catalog ?? [], extensionTools: catalogParentExtensionTools(options.parentTools, options.cwd), run: data.run, cursor: data.cursor, events: data.events ?? [], steps: data.steps ?? [], outputs: data.outputs ?? [], wait: data.wait, message: data.message, cleanup: data.cleanup, notice: data.notice, listedRuns: data.listedRuns, reattach: data.reattach, scheduledRuns: data.scheduledRuns, scheduleRegistration: data.scheduleRegistration, scheduleCancel: data.scheduleCancel };
}

export function finalizeDetails(details: AgentTeamDetails): AgentToolResult<AgentTeamDetails> {
	return { content: [{ type: "text", text: formatDetailsForModelContent(details) }], details };
}

export function hasDiagnosticError(diagnostics: AgentDiagnostic[]): boolean {
	return diagnostics.some((item) => item.severity === "error");
}

export function unavailableTools(): ParentToolInventory {
	return { apiAvailable: false, errorMessage: "parent tool inventory unavailable", tools: [] };
}

export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	timer.unref?.();
}
