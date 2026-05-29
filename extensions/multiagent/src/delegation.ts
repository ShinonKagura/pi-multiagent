/** Public detached agent_team action dispatcher. */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { catalogAgents, discoverAgents, normalizeLibraryOptions } from "./agents.ts";
import { DetachedRun } from "./detached-run.ts";
import { forgetDetachedRun, getDetachedRun, listDetachedRuns, registerDetachedRun } from "./detached-registry.ts";
import { materializeAgentTeamInput } from "./graph-file.ts";
import { resolveDetachedGraph, validatePreflightShape } from "./planning.ts";
import { finalizeDetails, hasDiagnosticError, makeDetails, type AgentTeamRuntimeOptions, unavailableTools } from "./runtime-options.ts";
import { schemaRepair } from "./schema-repair.ts";
import { catalogParentExtensionToolDiagnostics } from "./tool-policy.ts";
import { AgentTeamSchema, type AgentTeamInput, type GraphSpec } from "./schemas.ts";
import { listPersistedRuns, readPersistedRun, type PersistedRunListing } from "./persistent-run-state.ts";
import { isScheduleId, ScheduledRunRegistry } from "./scheduled-runs.ts";
import type { AgentDiagnostic, AgentTeamDetails, ListedRunSummary, ReattachSnapshot, RunSnapshot } from "./types.ts";
import { AGENT_TEAM_ACTION_VALUES, DEFAULT_GRAPH_LIBRARY_SOURCES, DEFAULT_RESULT_PREVIEW_MAX_BYTES, MAX_LIVE_DETACHED_RUNS, MAX_RETAINED_DETACHED_RUNS, type ExecutionAction } from "./types.ts";

const validateAgentTeamInput = Compile(AgentTeamSchema);

export async function runAgentTeam(rawInput: unknown, options: AgentTeamRuntimeOptions): Promise<AgentToolResult<AgentTeamDetails>> {
	const rawPreflightDiagnostics = validatePreflightShape(rawInput);
	const rawSchemaDiagnostics = validateInputSchema(rawInput);
	const rawDiagnostics = [...rawPreflightDiagnostics, ...rawSchemaDiagnostics];
	const materialized = hasDiagnosticError(rawDiagnostics) ? { input: rawInput, diagnostics: [] } : materializeAgentTeamInput(rawInput, options.cwd);
	const inputForValidation = materialized.input;
	const materializedPreflightDiagnostics = materialized.input === rawInput ? [] : validatePreflightShape(inputForValidation);
	const materializedSchemaDiagnostics = materialized.input === rawInput ? [] : validateInputSchema(inputForValidation);
	const diagnostics = [...options.materializationDiagnostics, ...options.catalogPreparationDiagnostics, ...rawDiagnostics, ...materialized.diagnostics, ...materializedPreflightDiagnostics, ...materializedSchemaDiagnostics];
	if (hasDiagnosticError(diagnostics)) return finalizeDetails(makeDetails(detailsAction(inputForValidation), false, diagnostics, options));
	const input = inputForValidation as AgentTeamInput;
	if (input.action === "catalog") return finalizeDetails(catalog(input, options, diagnostics));
	if (input.action === "start") return finalizeDetails(start(input, options, diagnostics));
	if (input.action === "run_status") return finalizeDetails(await run_status(input, options, diagnostics));
	if (input.action === "step_result") return finalizeDetails(step_result(input, options, diagnostics));
	if (input.action === "message") return finalizeDetails(await message(input, options, diagnostics));
	if (input.action === "cancel") return finalizeDetails(cancel(input, options, diagnostics));
	if (input.action === "cleanup") return finalizeDetails(cleanup(input, options, diagnostics));
	if (input.action === "list") return finalizeDetails(list(input, options, diagnostics));
	if (input.action === "reattach") return finalizeDetails(reattach(input, options, diagnostics));
	return finalizeDetails(makeDetails("missing/invalid", false, diagnostics, options, undefined, { code: "action-invalid", message: "Unknown action." }));
}

function list(_input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): AgentTeamDetails {
	const persisted = listPersistedRuns();
	const memoryRuns = listDetachedRuns();
	// NEU-C: include scheduled runs in the list payload (orthogonal to listedRuns).
	const scheduledRuns = options.scheduledRunRegistry?.list();
	const memoryByRunId = new Map(memoryRuns.map((run) => [run.id, run]));
	const summaries: ListedRunSummary[] = [];
	const persistedRunIds = new Set<string>();
	for (const listing of persisted) {
		persistedRunIds.add(listing.runId);
		summaries.push(buildListingSummary(listing, memoryByRunId.get(listing.runId), options));
	}
	// In-memory runs that did not (yet) produce a persistent record (e.g. persistence unavailable
	// for that run). Surface them so the operator can see they exist.
	for (const memRun of memoryRuns) {
		if (persistedRunIds.has(memRun.id)) continue;
		const snap = memRun.snapshot();
		summaries.push({
			runId: memRun.id,
			status: snap.status,
			terminal: snap.terminal,
			owned: memRun.isOwnedBy(options.sessionId),
			owner: memRun.isOwnedBy(options.sessionId) ? "this-session" : "foreign-session",
			ownerPid: process.pid,
			ownerPidAlive: true,
			ownerSessionId: undefined,
			createdAt: snap.createdAt,
			updatedAt: snap.updatedAt,
			terminalAt: undefined,
			invocationCwd: undefined,
			objective: snap.objective,
			runDir: "<memory-only>",
			worktreeCount: 0,
			worktreesPendingCleanup: 0,
		});
	}
	summaries.sort((a, b) => a.runId.localeCompare(b.runId));
	return makeDetails("list", true, diagnostics, options, { listedRuns: summaries, scheduledRuns });
}

function buildListingSummary(listing: PersistedRunListing, memoryRun: import("./detached-run.ts").DetachedRun | undefined, options: AgentTeamRuntimeOptions): ListedRunSummary {
	const manifest = listing.manifest;
	const owned = memoryRun ? memoryRun.isOwnedBy(options.sessionId) : false;
	let owner: ListedRunSummary["owner"];
	if (owned) owner = "this-session";
	else if (listing.lockHolderAlive) owner = "foreign-session";
	else if (listing.lockExistedButStale || !listing.lockHeldByPid) owner = "orphan";
	else owner = "unknown";
	return {
		runId: listing.runId,
		status: listing.status?.status ?? (memoryRun?.snapshot().status ?? "unknown"),
		terminal: listing.status?.terminal ?? memoryRun?.snapshot().terminal ?? false,
		owned,
		owner,
		ownerPid: listing.lockHeldByPid ?? manifest?.ownerPid,
		ownerPidAlive: listing.lockHeldByPid === undefined ? undefined : listing.lockHolderAlive,
		ownerSessionId: manifest?.ownerSessionId,
		createdAt: manifest?.createdAt ?? listing.status?.updatedAt ?? new Date(0).toISOString(),
		updatedAt: listing.status?.updatedAt,
		terminalAt: listing.status?.terminalAt,
		invocationCwd: manifest?.invocationCwd,
		objective: manifest?.objective,
		runDir: listing.runDir,
		worktreeCount: listing.worktrees.length,
		worktreesPendingCleanup: listing.worktrees.filter((w) => !w.cleanedUp).length,
	};
}

function reattach(input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): AgentTeamDetails {
	if (!input.runId) return makeDetails("reattach", false, diagnostics, options, undefined, { code: "run-id-required", message: "reattach requires runId." });
	const listing = readPersistedRun(input.runId);
	if (!listing) return makeDetails("reattach", false, diagnostics, options, undefined, { code: "reattach-run-not-found", message: `No persisted run state found for runId "${input.runId}". Use the list action to discover available runs (orphaned and terminal runs are visible if they have persistent state on disk).` });
	if (!listing.manifest) return makeDetails("reattach", false, diagnostics, options, undefined, { code: "reattach-manifest-missing", message: `Persistent run dir for ${input.runId} exists but manifest.json is missing or unparseable; this may be a half-created run. Inspect ${listing.runDir} directly.` });
	const memoryRun = getDetachedRun(input.runId);
	const owned = memoryRun ? memoryRun.isOwnedBy(options.sessionId) : false;
	let owner: ReattachSnapshot["owner"];
	if (owned) owner = "this-session";
	else if (listing.lockHolderAlive) owner = "foreign-session";
	else if (listing.lockExistedButStale || !listing.lockHeldByPid) owner = "orphan";
	else owner = "unknown";
	const controlDenied = owner !== "this-session";
	const controlDeniedReason = controlDenied ? `reattach returned a read-only snapshot. mutation actions (message, cancel, cleanup) on runs owned by ${owner === "foreign-session" ? "another live Pi session" : owner === "orphan" ? "a dead owner process" : "an unknown owner"} are denied. See operator runbook for orphan recovery options.` : undefined;
	const snapshot: ReattachSnapshot = {
		runId: listing.runId,
		runDir: listing.runDir,
		owned,
		owner,
		manifest: listing.manifest,
		status: listing.status ? { status: listing.status.status, updatedAt: listing.status.updatedAt, terminal: listing.status.terminal, terminalAt: listing.status.terminalAt } : undefined,
		worktrees: listing.worktrees.map((w) => ({ stepId: w.stepId, worktreePath: w.worktreePath, branchName: w.branchName, baseCommit: w.baseCommit, repoRoot: w.repoRoot, cleanedUp: w.cleanedUp })),
		artifactPaths: listing.artifactPaths,
		readOnly: true,
		controlDenied,
		controlDeniedReason,
	};
	return makeDetails("reattach", true, diagnostics, options, { reattach: snapshot });
}

function catalog(input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): AgentTeamDetails {
	const discovery = discoverAgents({ cwd: options.cwd, packageAgentsDir: options.packageAgentsDir, library: options.catalogLibrary });
	const allDiagnostics = [...diagnostics, ...discovery.diagnostics, ...catalogParentExtensionToolDiagnostics(options.parentTools)];
	return makeDetails("catalog", !hasDiagnosticError(allDiagnostics), allDiagnostics, options, { library: { ...options.catalogLibrary, sources: discovery.sources }, catalog: catalogAgents(discovery, options.catalogLibrary.query) });
}

function start(input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): AgentTeamDetails {
	if (options.signal?.aborted) return makeDetails("start", false, diagnostics, options, undefined, { code: "start-aborted-before-run-id", message: "Start was aborted before a runId was registered; no child process was launched." });
	const graph = input.graph as GraphSpec | undefined;
	if (!graph) return makeDetails("start", false, diagnostics, options, undefined, { code: "start-graph-missing", message: "Start requires graph or graphFile." });
	// NEU-C: if schedule is set, register the schedule instead of spawning the graph now.
	if (input.options?.schedule && options.scheduledRunRegistry) {
		const result = options.scheduledRunRegistry.register({ spec: input.options.schedule, graph, ownerSessionId: options.sessionId });
		if (!result.ok) return makeDetails("start", false, diagnostics, options, undefined, { code: "schedule-invalid", message: result.error });
		return makeDetails("start", true, diagnostics, options, { scheduleRegistration: { scheduleId: result.id, kind: result.parsed.kind, nextFireAt: result.parsed.firesAtIso ?? new Date(Date.now() + result.parsed.milliseconds).toISOString() } });
	}
	const librarySources = graph.library?.sources && graph.library.sources.length > 0 ? graph.library.sources : DEFAULT_GRAPH_LIBRARY_SOURCES;
	const library = normalizeLibraryOptions({ sources: librarySources, projectAgents: graph.authority?.allowProjectCode ? "allow" : "deny" });
	const discovery = discoverAgents({ cwd: options.cwd, packageAgentsDir: options.packageAgentsDir, library });
	const resolved = resolveDetachedGraph(graph, discovery.agents, [...diagnostics, ...discovery.diagnostics], { cwd: options.cwd, invocationCwd: options.cwd, parentTools: options.parentTools ?? unavailableTools(), parentSkills: options.parentSkills, subagentSkillMode: options.subagentSkills?.mode }, input.options);
	if (resolved.steps.length !== graph.steps.length || hasDiagnosticError(resolved.diagnostics)) return makeDetails("start", false, resolved.diagnostics, options, { library: { ...library, sources: discovery.sources } }, { code: "start-planning-failed", message: "Detached graph planning failed; no child process was launched." });
	const capacityError = detachedRunCapacityError(options);
	if (capacityError) return makeDetails("start", false, resolved.diagnostics, options, { library: { ...library, sources: discovery.sources } }, capacityError);
	const runId = createRunId();
	if (!runId) return makeDetails("start", false, resolved.diagnostics, options, { library: { ...library, sources: discovery.sources } }, { code: "run-id-exhausted", message: "No short process-local runId is available; reload Pi to reset process-local handles." });
	const run = new DetachedRun(runId, resolved, detachedRunOptions(options), { ...library, sources: discovery.sources });
	registerDetachedRun(run);
	run.start();
	return run.details("start");
}

async function run_status(input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): Promise<AgentTeamDetails> {
	const run = getOwnedDetachedRun(input.runId, options);
	if (!run) return makeDetails("run_status", false, diagnostics, options, undefined, runNotFoundError(options));
	const requestDiagnostics = runStatusRequestDiagnostics(input);
	if (input.stepId && !run.hasStep(input.stepId)) return run.details("run_status", { stepId: input.stepId, maxBytes: input.maxBytes ?? DEFAULT_RESULT_PREVIEW_MAX_BYTES, preview: input.preview === true, diagnostics: requestDiagnostics, ok: false, error: { code: "step-not-found", message: "No step in the retained detached run matches stepId." } });
	const wait = input.waitSeconds !== undefined ? await run.waitForChange({ stepId: input.stepId, cursor: input.cursor, seconds: input.waitSeconds }) : undefined;
	return run.details("run_status", { cursor: input.cursor, stepId: input.stepId, maxBytes: input.maxBytes ?? DEFAULT_RESULT_PREVIEW_MAX_BYTES, preview: input.preview === true, includeEvents: input.debugEvents === true, diagnostics: requestDiagnostics, wait });
}

function runStatusRequestDiagnostics(input: AgentTeamInput): AgentDiagnostic[] {
	if (!input.stepId || input.preview !== true) return [];
	return [{ code: "run-status-step-preview-ignored", message: "run_status stepId filters wait/debug events only; use step_result with this stepId for a step text preview.", path: "/stepId", severity: "warning" }];
}

function step_result(input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): AgentTeamDetails {
	const run = getOwnedDetachedRun(input.runId, options);
	if (!run) return makeDetails("step_result", false, diagnostics, options, undefined, runNotFoundError(options));
	if (!input.stepId || !run.hasStep(input.stepId)) return run.details("step_result", { stepId: input.stepId, maxBytes: input.maxBytes ?? DEFAULT_RESULT_PREVIEW_MAX_BYTES, preview: input.preview === true, ok: false, error: { code: "step-not-found", message: "No step in the retained detached run matches stepId." } });
	return run.details("step_result", { stepId: input.stepId, maxBytes: input.maxBytes ?? DEFAULT_RESULT_PREVIEW_MAX_BYTES, preview: input.preview === true });
}

async function message(input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): Promise<AgentTeamDetails> {
	const run = getOwnedDetachedRun(input.runId, options);
	if (!run) return makeDetails("message", false, diagnostics, options, undefined, runNotFoundError(options));
	if (!input.stepId || !run.hasStep(input.stepId)) return run.details("message", { stepId: input.stepId, ok: false, error: { code: "step-not-found", message: "No step in the retained detached run matches stepId." } });
	const receipt = await run.message(input.stepId, input.channel ?? "steer", input.text ?? "", input.clientMessageId);
	return run.details("message", { message: receipt, ok: receipt.accepted, error: receipt.accepted ? undefined : { code: "message-not-delivered", message: receipt.undeliveredReason ?? "Message was not delivered." } });
}

function cancel(input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): AgentTeamDetails {
	// NEU-C: scheduleId takes precedence; falls back to runId routing.
	const scheduleId = input.scheduleId ?? (input.runId && isScheduleId(input.runId) ? input.runId : undefined);
	if (scheduleId && options.scheduledRunRegistry) {
		const result = options.scheduledRunRegistry.cancel(scheduleId, options.sessionId);
		if (!result.ok) return makeDetails("cancel", false, diagnostics, options, undefined, { code: "schedule-cancel-failed", message: result.error });
		return makeDetails("cancel", true, diagnostics, options, { scheduleCancel: { scheduleId, canceled: true, reason: input.reason } });
	}
	const run = getOwnedDetachedRun(input.runId, options);
	if (!run) return makeDetails("cancel", false, diagnostics, options, undefined, runNotFoundError(options));
	run.cancel(input.reason);
	return run.details("cancel");
}

function cleanup(input: AgentTeamInput, options: AgentTeamRuntimeOptions, diagnostics: AgentDiagnostic[]): AgentTeamDetails {
	const run = getOwnedDetachedRun(input.runId, options);
	if (!run) return makeDetails("cleanup", false, diagnostics, options, undefined, runNotFoundError(options));
	if (!run.snapshot().terminal) return run.details("cleanup", { ok: false, error: { code: "cleanup-run-live", message: "Cleanup is denied while the run is live; let healthy work finish, or cancel only when stopping is explicit, then run_status terminal state first." } });
	try {
		const receipt = run.cleanup();
		forgetDetachedRun(run.id);
		return makeDetails("cleanup", true, diagnostics, options, { cleanup: receipt });
	} catch (error) {
		return run.details("cleanup", { ok: false, error: { code: "cleanup-artifacts-failed", message: `Cleanup failed while deleting retained artifacts: ${error instanceof Error ? error.message : String(error)}` } });
	}
}

function runNotFoundError(options: AgentTeamRuntimeOptions): { code: string; message: string } {
	const runs = listDetachedRuns().filter((run) => run.isOwnedBy(options.sessionId)).map((run) => run.snapshot());
	const recent = summarizeRunCapacity(runs);
	return { code: "run-not-found", message: `No retained detached run matches runId. Run handles are process/session-local and can disappear after retention expiry, cleanup, extension reload, or session shutdown; preserve artifact paths before cleanup. Retained runs now: ${runs.length}; recent: ${recent}.` };
}

function getOwnedDetachedRun(runId: string | undefined, options: AgentTeamRuntimeOptions): DetachedRun | undefined {
	const run = getDetachedRun(runId);
	return run?.isOwnedBy(options.sessionId) ? run : undefined;
}

function detachedRunCapacityError(options: AgentTeamRuntimeOptions): { code: string; message: string } | undefined {
	const runs = listDetachedRuns();
	return detachedRunCapacityErrorForSnapshots(runs.map((run) => run.snapshot()), runs.filter((run) => run.isOwnedBy(options.sessionId)).map((run) => run.snapshot()));
}

export function detachedRunCapacityErrorForSnapshots(snapshots: RunSnapshot[], ownedSnapshots: RunSnapshot[] = snapshots): { code: string; message: string } | undefined {
	const liveRuns = snapshots.filter((run) => !run.terminal);
	const terminalRuns = snapshots.filter((run) => run.terminal);
	const ownedLiveRuns = ownedSnapshots.filter((run) => !run.terminal);
	const ownedTerminalRuns = ownedSnapshots.filter((run) => run.terminal);
	if (liveRuns.length >= MAX_LIVE_DETACHED_RUNS) return { code: "detached-run-live-cap-reached", message: `Too many live detached runs (${liveRuns.length}); run_status and preserve evidence, then cancel only runs that are stuck, obsolete, unsafe, or explicitly lower value than the new work. Maximum live runs: ${MAX_LIVE_DETACHED_RUNS}. Live runs: ${summarizeScopedRunCapacity(liveRuns, ownedLiveRuns, "live")}.` };
	if (snapshots.length >= MAX_RETAINED_DETACHED_RUNS) return { code: "detached-run-retained-cap-reached", message: `Too many retained detached runs (${snapshots.length}); free capacity by cleaning up terminal runs only after preserving needed artifacts, or by canceling live runs only when they are stuck, obsolete, unsafe, or explicitly lower value than the new work. Maximum retained runs: ${MAX_RETAINED_DETACHED_RUNS}. Live runs (${liveRuns.length}): ${summarizeScopedRunCapacity(liveRuns, ownedLiveRuns, "live")}. Terminal runs (${terminalRuns.length}): ${summarizeScopedRunCapacity(terminalRuns, ownedTerminalRuns, "terminal")}.` };
	return undefined;
}

function summarizeScopedRunCapacity(allRuns: RunSnapshot[], ownedRuns: RunSnapshot[], label: string): string {
	const otherCount = Math.max(0, allRuns.length - ownedRuns.length);
	const owned = summarizeRunCapacity(ownedRuns);
	if (otherCount === 0) return owned;
	return `owned: ${owned}; other sessions: ${otherCount} ${label}`;
}

function summarizeRunCapacity(runs: RunSnapshot[]): string {
	const rows = runs.slice(0, 5).map((run) => `${run.runId}:${run.status}`).join(", ");
	if (runs.length === 0) return "none";
	return runs.length > 5 ? `${rows}, +${runs.length - 5} more` : rows;
}

function detachedRunOptions(options: AgentTeamRuntimeOptions): AgentTeamRuntimeOptions {
	return { ...options, onUpdate: undefined };
}

function validateInputSchema(input: unknown): AgentDiagnostic[] {
	if (validateAgentTeamInput.Check(input)) return [];
	const errors = [...validateAgentTeamInput.Errors(input)].slice(0, 5);
	if (errors.length === 0) return [{ code: "input-schema-invalid", message: "agent_team input does not match the public schema; check action-specific fields, enum values, bounds, and unknown properties.", path: "/", severity: "error", repair: schemaRepair(input, "/") }];
	return errors.map((error) => {
		const path = error.instancePath || "/";
		return { code: "input-schema-invalid", message: `agent_team input schema violation at ${path}: ${error.message}`, path, severity: "error", repair: schemaRepair(input, path) };
	});
}

function detailsAction(input: unknown): ExecutionAction | "missing/invalid" {
	if (!isRecord(input) || typeof input.action !== "string") return "missing/invalid";
	if (AGENT_TEAM_ACTION_VALUES.includes(input.action as ExecutionAction)) return input.action as ExecutionAction;
	return "missing/invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const MAX_RUN_ID_SERIAL = 9_999_999;
let nextRunIdSerial = 1;
let runIdSerialSeeded = false;

/** Highest `rN` serial among the given runIds (0 if none). Pure, for deterministic testing. */
export function highestPersistedRunIdSerial(runIds: readonly string[]): number {
	let highest = 0;
	for (const runId of runIds) {
		const match = /^r([1-9][0-9]*)$/.exec(runId);
		if (match) {
			const serial = Number(match[1]);
			if (serial > highest) highest = serial;
		}
	}
	return highest;
}

/** OPEN-2: runIds are process-local (`r1`, `r2`, ...) but persistent run dirs survive across
 * processes. Without seeding, a fresh process restarts at r1 and collides with an orphaned r1 on
 * disk — createPersistentRun refuses the foreign-pid dir and the run fails. Seed the serial past the
 * highest run already persisted so new runs never reuse an orphan's id. Lazy + best-effort. */
function seedRunIdSerialFromDisk(): void {
	if (runIdSerialSeeded) return;
	runIdSerialSeeded = true;
	try {
		const highest = highestPersistedRunIdSerial(listPersistedRuns().map((listing) => listing.runId));
		if (highest >= nextRunIdSerial) nextRunIdSerial = highest + 1;
	} catch {
		/* best-effort: fall back to in-memory-only allocation */
	}
}

function createRunId(): string | undefined {
	seedRunIdSerialFromDisk();
	while (nextRunIdSerial <= MAX_RUN_ID_SERIAL) {
		const candidate = `r${nextRunIdSerial}`;
		nextRunIdSerial += 1;
		if (!getDetachedRun(candidate)) return candidate;
	}
	return undefined;
}
