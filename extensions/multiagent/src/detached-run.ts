import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { createRunArtifactStore, cleanupRunArtifacts, type RunArtifactStore } from "./background-artifacts.ts";
import { BackgroundEventStore } from "./background-events.ts";
import { buildDelegatedTask, writePromptFile } from "./delegated-prompt.ts";
import { isTerminalRunStatus, isTerminalStepStatus } from "./detached-output.ts";
import { sendDetachedMessage } from "./detached-message.ts";
import { selectOutputsForAction } from "./detached-output-selection.ts";
import { forgetDetachedRun } from "./detached-registry.ts";
import { createPendingStepState, type StepState } from "./detached-state.ts";
import { summarizeBackgroundEvent } from "./event-summary.ts";
import { createStepActivityTracker } from "./step-activity.ts";
import { validateLaunchCwd } from "./launch-cwd.ts";
import { findStepLaunchDenial } from "./launch-denial.ts";
import { createMessageReceiptCache } from "./message-idempotency.ts";
import { RpcChildController } from "./rpc-child-controller.ts";
import type { RpcStepResult } from "./rpc-child-types.ts";
import { RunNotifier, stepNoticeReasons, terminalStepNoticeReasons } from "./run-notifier.ts";
import type { DetachedRunDetailsOptions, DetachedRunEventInput } from "./detached-run-options.ts";
import { terminalRunStatus } from "./run-terminal-status.ts";
import { RunWaiters } from "./run-waiters.ts";
import { createRunUiCallback } from "./run-ui-callback.ts";
import { makeDetails, type AgentTeamRuntimeOptions, unrefTimer } from "./runtime-options.ts";
import { buildRunSnapshot, buildStepSnapshots, countStepStatuses, findSinkStepIds } from "./run-snapshot.ts";
import { createStepOutputArtifact } from "./step-output-artifact.ts";
import { stalledStepBlockerMessage } from "./stalled-step-diagnostics.ts";
import { collectUpstreamOutputs } from "./upstream-outputs.ts";
import { prepareWorktreeForStep, teardownWorktreeForStep, WorktreeError } from "./mutation-worktree.ts";
import { createPersistentRun, deletePersistentRun, markWorktreeCleanedUp, mirrorArtifactToRunDir, recordWorktreeForStep, releasePersistentRun, updatePersistentRunStatus, type PersistentRunHandle } from "./persistent-run-state.ts";
import type { AgentDiagnostic, AgentTeamDetails, LibraryOptions, MessageChannel, ResolvedGraph, RunStatus, RunStatusWaitReceipt, StepArtifactReference, StepStatus, TeamStepSpec } from "./types.ts";
import { DEFAULT_RESULT_PREVIEW_MAX_BYTES as PREVIEW_BYTES } from "./types.ts";

export class DetachedRun {
	readonly id: string;
	readonly ownerKey: string;
	readonly createdAt = new Date().toISOString();
	private readonly graph: ResolvedGraph;
	private readonly options: AgentTeamRuntimeOptions;
	private readonly library: LibraryOptions;
	private updatedAt = this.createdAt;
	private status: RunStatus = "running";
	private readonly events = new BackgroundEventStore();
	private readonly stepActivity = createStepActivityTracker();
	private readonly artifactStore: RunArtifactStore;
	private readonly states = new Map<string, StepState>();
	private readonly messageReceipts = createMessageReceiptCache();
	private readonly diagnostics: AgentDiagnostic[];
	private readonly notifier: RunNotifier;
	private expiryRequested = false;
	private maxRunTimer: ReturnType<typeof setTimeout> | undefined;
	private retentionTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly waiters = new RunWaiters();
	private readonly runUi = createRunUiCallback((message) => this.recordDiagnostic("run-ui-callback-failed", "run-ui", message));
	private readonly persistent: PersistentRunHandle | undefined;

	constructor(id: string, graph: ResolvedGraph, options: AgentTeamRuntimeOptions, library: LibraryOptions) {
		this.id = id;
		this.ownerKey = runOwnerKey(options.sessionId);
		this.graph = graph;
		this.options = options;
		this.library = library;
		this.diagnostics = [...graph.diagnostics];
		this.artifactStore = createRunArtifactStore();
		this.notifier = new RunNotifier({ runId: id, notify: graph.options.notify, runtimeOptions: options, recordDiagnostic: (code, label, message) => this.recordDiagnostic(code, label, message), isTerminal: () => this.snapshot().terminal, details: (notice) => this.details("run_status", { notice }) });
		for (const step of graph.steps) this.states.set(step.id, createPendingStepState(step));
		this.persistent = createPersistentRun({ runId: id, manifest: { runId: id, createdAt: this.createdAt, invocationCwd: options.cwd, objective: graph.objective, ownerPid: process.pid, ownerSessionId: options.sessionId, piVersion: undefined, terminalRetentionSeconds: graph.options.terminalRetentionSeconds } });
		if (!this.persistent) {
			// NEU-A B1a + F5 interlock: when persistence is unavailable, any worktree-isolated
			// step would leak guaranteed on Pi crash because no on-disk worktrees.json record
			// exists for the startup sweep to find. Fail closed at construction time instead
			// of warning and proceeding; the operator must fix persistence (XDG_STATE_HOME /
			// ~/.local/state writability or PI_MULTIAGENT_STATE_DIR override) before retrying.
			const worktreeStepIds = graph.steps.filter((step) => step.isolation === "worktree").map((step) => step.id);
			if (worktreeStepIds.length > 0) {
				this.recordDiagnostic("persistent-run-unavailable-with-worktree", "persistent", `Persistent run state could not be initialized and steps [${worktreeStepIds.join(", ")}] request isolation:"worktree". Worktree leaks on Pi crash would be unrecoverable. Fix XDG_STATE_HOME / ~/.local/state writability or set PI_MULTIAGENT_STATE_DIR to a writable path, then retry. Failing closed.`);
				this.status = "failed";
				for (const state of this.states.values()) state.status = "failed";
				this.appendEvent({ type: "run", label: "terminal", preview: "persistent-run-unavailable-with-worktree", status: "error" });
			} else {
				this.recordDiagnostic("persistent-run-unavailable", "persistent", "Persistent run state could not be initialized; run continues in memory only. No F5 worktree isolation is in use, so this run cannot leak worktrees. Pi crash will still lose in-flight observability of this run. Check XDG_STATE_HOME / ~/.local/state writability or PI_MULTIAGENT_STATE_DIR override.");
			}
		}
	}

	start(): void {
		if (isTerminalRunStatus(this.status)) {
			// Run was failed-closed in constructor (e.g. persistent-run-unavailable-with-worktree).
			// Skip the normal start sequence and emit terminal notice for parent observability.
			this.notifier.sendTerminal(this.status, ["pre-start fail-closed"]);
			this.emitLifecycle("pi-multiagent:run-failed-pre-start", { runId: this.id, status: this.status });
			this.scheduleRetention();
			return;
		}
		this.appendEvent({ type: "run", label: "start", preview: `runId=${this.id}`, status: "running" });
		this.emitLifecycle("pi-multiagent:run-started", { runId: this.id, objective: this.graph.objective, stepCount: this.graph.steps.length });
		this.maxRunTimer = setTimeout(() => this.expire(), this.graph.options.maxRunSeconds * 1000);
		unrefTimer(this.maxRunTimer);
		queueMicrotask(() => void this.schedule());
	}

	/** G4: best-effort lifecycle event emission. Never throws. */
	private emitLifecycle(eventName: string, payload: Record<string, unknown>): void {
		this.emitLifecycleRaw(eventName, payload);
		// Dual-brand: mirror every pi-multiagent: lifecycle event under the hb-orchestra: prefix so
		// cross-extension consumers can subscribe to the new brand without breaking legacy subscribers.
		if (eventName.startsWith("pi-multiagent:")) this.emitLifecycleRaw(`hb-orchestra:${eventName.slice("pi-multiagent:".length)}`, payload);
	}

	private emitLifecycleRaw(eventName: string, payload: Record<string, unknown>): void {
		try {
			this.options.emitLifecycleEvent?.(eventName, payload);
		} catch {
			// ignore; events are best-effort
		}
	}

	isOwnedBy(sessionId: string | undefined): boolean {
		return this.ownerKey === runOwnerKey(sessionId);
	}

	hasStep(stepId: string) {
		return this.states.has(stepId);
	}

	async waitForChange(input: { stepId?: string; cursor?: string; seconds: number }): Promise<RunStatusWaitReceipt> {
		const cursorBefore = input.cursor ?? this.events.currentCursor();
		let outcome: RunStatusWaitReceipt["outcome"];
		if (this.snapshot().terminal) {
			outcome = "terminal";
		} else {
			const sinks = this.sinkStepIds();
			if (this.events.hasMaterialAfter(cursorBefore, input.stepId, sinks)) {
				outcome = "already-material";
			} else {
				outcome = await this.waiters.add({ stepId: input.stepId, sinkStepIds: sinks, milliseconds: input.seconds * 1000 });
			}
		}
		return {
			requestedSeconds: input.seconds,
			outcome,
			stepId: input.stepId,
			cursorBefore,
			cursorAfter: this.events.currentCursor(),
		};
	}

	async message(stepId: string, channel: MessageChannel, text: string, clientMessageId: string | undefined) {
		return sendDetachedMessage({ runId: this.id, runStatus: this.status, states: this.states, receipts: this.messageReceipts, stepId, channel, text, clientMessageId, appendEvent: (event) => this.appendEvent(event) });
	}

	cancel(reason?: string, options: { forceKill?: boolean } = {}) {
		if (this.snapshot().terminal) return;
		this.status = "canceling";
		this.touch();
		this.appendEvent({ type: "run", label: "cancel", preview: reason ?? "cancel", status: "running" });
		for (const state of this.states.values()) {
			if (state.status === "pending") this.finishState(state, "canceled", reason ?? "Canceled before start.");
			else if (state.status === "running" && state.controller) {
				state.controller.cancel(reason);
				if (options.forceKill) state.controller.forceKill(reason ?? "kill");
			} else if (state.status === "running") this.finishState(state, "canceled", reason ?? "Canceled before launch.");
		}
		void this.schedule();
	}

	cleanup() {
		const deletedPaths = cleanupRunArtifacts(this.artifactStore);
		if (this.maxRunTimer) clearTimeout(this.maxRunTimer);
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		this.notifier.cancelTimers();
		deletePersistentRun(this.persistent);
		this.appendEvent({ type: "run", label: "cleanup", preview: `${deletedPaths.length} paths deleted`, status: "done" });
		return { runId: this.id, deletedPaths };
	}

	details(action: AgentTeamDetails["action"], options: DetachedRunDetailsOptions = {}): AgentTeamDetails {
		const includeEvents = options.includeEvents === true;
		const delta = includeEvents ? this.events.delta(options.cursor, options.stepId, options.maxBytes ?? PREVIEW_BYTES) : { events: [], cursor: this.events.currentCursor() };
		return makeDetails(action, options.ok ?? true, [...this.diagnostics, ...(options.diagnostics ?? [])], this.options, { library: this.library, run: this.snapshot(), cursor: delta.cursor, events: delta.events, steps: this.stepSnapshots(), outputs: selectOutputsForAction(action, options.stepId, options.maxBytes ?? PREVIEW_BYTES, options.preview === true, this.states.values(), this.sinkStepIds()), wait: options.wait, message: options.message, cleanup: options.cleanup, notice: options.notice }, options.error);
	}

	snapshot() {
		const liveStepIds = this.stepSnapshots().filter((step) => step.status === "running").map((step) => step.id);
		return buildRunSnapshot({ runId: this.id, objective: this.graph.objective, status: this.status, createdAt: this.createdAt, updatedAt: this.updatedAt, retentionSeconds: this.graph.options.terminalRetentionSeconds, liveStepIds, sinkStepIds: this.sinkStepIds(), lastEvent: this.lastEventSummary(), canMessage: this.status === "running" && liveStepIds.length > 0, canCancel: this.status === "running" || this.status === "canceling", counts: this.counts() });
	}

	private async schedule() {
		while (this.status === "running" || this.status === "canceling") {
			let progressed = this.blockFailedDependents();
			progressed = this.startReadySteps() || progressed;
			const running = [...this.states.values()].filter((state) => state.promise !== undefined).map((state) => state.promise as Promise<void>);
			if (running.length === 0) {
				this.finalizeIfDone();
				if (this.snapshot().terminal) return;
				if (!progressed) {
					this.blockStalledPendingSteps();
					this.finalizeIfDone();
					return;
				}
				continue;
			}
			await Promise.race(running);
		}
	}

	private startReadySteps() {
		if (this.status !== "running") return false;
		let progressed = false;
		let slots = this.graph.limits.concurrency - [...this.states.values()].filter((state) => state.status === "running").length;
		if (slots <= 0) return false;
		for (const state of this.states.values()) {
			if (this.status !== "running" || slots <= 0) return progressed;
			if (state.status !== "pending" || !this.dependenciesReady(state.spec)) continue;
			const result = this.startStep(state);
			progressed = result.progressed || progressed;
			if (result.startedChild) slots -= 1;
		}
		return progressed;
	}

	private startStep(state: StepState) {
		const denial = findStepLaunchDenial(state.spec);
		if (denial) {
			this.finishState(state, "failed", denial);
			return { progressed: true, startedChild: false };
		}
		state.status = "running";
		state.startedAt = now();
		this.touch();
		this.appendEvent({ stepId: state.spec.id, type: "step", label: "start", preview: state.spec.agent.ref, status: "running" });
		state.promise = this.runStep(state).finally(() => {
			state.promise = undefined;
			void this.schedule();
		});
		return { progressed: true, startedChild: true };
	}

	private async runStep(state: StepState) {
		try {
			if (state.status !== "running" || this.status !== "running") return;
			const promptPath = writePromptFile(state.spec.agent, this.artifactStore, state.spec.id);
			if (state.status !== "running" || this.status !== "running") return;
			const launchDenial = findStepLaunchDenial(state.spec);
			if (launchDenial) {
				this.finishState(state, "failed", launchDenial);
				return;
			}
			const cwdDenial = validateLaunchCwd(state.spec);
			if (cwdDenial) {
				this.finishState(state, "failed", cwdDenial);
				return;
			}
			let effectiveCwd = state.spec.cwd;
			if (state.spec.isolation === "worktree") {
				try {
					const invocationCwd = this.options.cwd ?? state.spec.cwd;
					state.worktreeState = prepareWorktreeForStep({ invocationCwd, stepId: state.spec.id, runId: this.id, worktreeSetup: state.spec.worktreeSetup });
					// I3 FIX: if step.cwd points to a subdir inside the invocation cwd (not the invocation cwd itself),
					// resolve it relative to the worktree root so the child launches in the intended subdir of the worktree,
					// not in the invocation cwd outside the worktree.
					if (state.spec.cwd !== invocationCwd) {
						const stepRelative = relative(invocationCwd, state.spec.cwd);
						const candidate = join(state.worktreeState.worktreePath, stepRelative);
						try {
							const stat = lstatSync(candidate);
							if (!stat.isDirectory()) throw new Error("not a directory");
							effectiveCwd = candidate;
						} catch {
							this.finishState(state, "failed", `worktree-step-cwd-missing: step.cwd '${state.spec.cwd}' resolved to '${candidate}' inside worktree but does not exist; declare it in worktreeSetup.symlinkPaths if it lives outside the tracked tree`);
							return;
						}
					} else {
						effectiveCwd = state.worktreeState.worktreePath;
					}
					recordWorktreeForStep(this.persistent, { stepId: state.spec.id, worktreePath: state.worktreeState.worktreePath, branchName: state.worktreeState.branchName, baseCommit: state.worktreeState.baseCommit, repoRoot: state.worktreeState.repoRoot });
					this.appendEvent({ stepId: state.spec.id, type: "step", label: "worktree-prepared", preview: `branch=${state.worktreeState.branchName} base=${state.worktreeState.baseCommit.slice(0, 8)}`, status: "running" });
				} catch (error) {
					const code = error instanceof WorktreeError ? error.code : "worktree-prepare-failed";
					const message = error instanceof Error ? error.message : String(error);
					this.finishState(state, "failed", `${code}: ${message}`);
					return;
				}
			}
			const task = buildDelegatedTask(this.graph.objective, state.spec, collectUpstreamOutputs(state.spec, this.states));
			let rpcResult: RpcStepResult | undefined;
			let rpcError: unknown;
			try {
				// B1 runtime fallback: try the step's primary model, then its declared fallbackModels in
				// order, retrying only on a failure that looks like a model/provider availability error.
				const candidateModels = modelCandidates(state.spec.agent);
				for (let attempt = 0; attempt < candidateModels.length; attempt++) {
					const model = candidateModels[attempt];
					const controller = new RpcChildController({
						agent: model === state.spec.agent.model ? state.spec.agent : { ...state.spec.agent, model },
						defaults: this.options.defaults,
						limits: this.graph.limits,
						cwd: effectiveCwd,
						promptPath,
						spawnProcess: this.options.spawnProcess ?? spawn,
						ackTimeoutMs: this.options.rpcCommandAckTimeoutMs,
						outputLimit: state.spec.outputLimit,
						onText: (text) => this.updateLiveText(state, text),
						onEvent: (event) => this.appendEvent({ ...event, stepId: state.spec.id }),
					});
					state.controller = controller;
					const result = await controller.run(task);
					if (result.status === "failed" && attempt < candidateModels.length - 1 && isRetryableModelError(result.errorMessage)) {
						this.appendEvent({ stepId: state.spec.id, type: "step", label: "model-fallback", preview: `model ${model ?? "(default)"} failed (${(result.errorMessage ?? "").slice(0, 120)}); retrying with ${candidateModels[attempt + 1] ?? "(default)"}`, status: "warning" });
						continue;
					}
					rpcResult = result;
					break;
				}
			} catch (error) {
				rpcError = error;
			} finally {
				if (state.worktreeState) {
					try {
						state.worktreeEvidence = teardownWorktreeForStep({ state: state.worktreeState, artifactStore: this.artifactStore });
						markWorktreeCleanedUp(this.persistent, state.spec.id);
						this.appendEvent({ stepId: state.spec.id, type: "step", label: "worktree-torn-down", preview: state.worktreeEvidence.patchPath ? `patch=${state.worktreeEvidence.patchPath}` : "no patch", status: "done" });
						for (const warning of state.worktreeEvidence.cleanupWarnings) this.recordDiagnostic("worktree-cleanup-warning", state.spec.id, warning);
					} catch (error) {
						this.recordDiagnostic("worktree-teardown-failed", state.spec.id, error instanceof Error ? error.message : String(error));
					}
				}
			}
			if (rpcResult) this.finishFromRpcResult(state, rpcResult);
			else if (rpcError) this.finishState(state, "failed", rpcError instanceof Error ? rpcError.message : String(rpcError));
		} catch (error) {
			this.finishState(state, "failed", error instanceof Error ? error.message : String(error));
		}
	}

	private finishFromRpcResult(state: StepState, result: RpcStepResult) {
		const status = result.status === "timed_out" || result.status === "canceled" || result.status === "failed" ? result.status : "succeeded";
		state.finalText = result.text;
		state.assistantFinals = result.assistantFinals;
		state.output = this.createStepOutput(state, status, result.text, result.assistantFinals, result.errorMessage, result.nonFinalText);
		if (result.stderr.length > 0) this.appendEvent({ stepId: state.spec.id, type: "diagnostic", label: "stderr", preview: result.stderr, status: "done" });
		this.finishState(state, status, result.errorMessage);
	}

	private createStepOutput(state: StepState, status: StepStatus, text: string, assistantFinals: string[] = [], stopReason?: string, nonFinalText?: string) {
		const output = createStepOutputArtifact({ runId: this.id, objective: this.graph.objective, artifactStore: this.artifactStore, diagnostics: this.diagnostics, events: this.events, state, status, text, assistantFinals, stopReason, upstreamArtifacts: this.upstreamArtifactReferences(state.spec), nonFinalText, worktree: state.worktreeEvidence });
		// G1: mirror the step final artifact and any worktree patch into the persistent
		// run dir so reattach can find them after the original tmp RunArtifactStore is gone.
		if (output.filePath) mirrorArtifactToRunDir(this.persistent, output.filePath, `${state.spec.id}-final.md`);
		if (state.worktreeEvidence?.patchPath) mirrorArtifactToRunDir(this.persistent, state.worktreeEvidence.patchPath, `${state.spec.id}-worktree.patch`);
		return output;
	}

	private updateLiveText(state: StepState, text: string) {
		if (text === state.liveText) return;
		const previousEventChars = state.liveTextEventChars;
		state.liveText = text;
		if (previousEventChars === 0 || text.length - previousEventChars >= 1000) {
			state.liveTextEventChars = text.length;
			this.appendEvent({ stepId: state.spec.id, type: "assistant_delta", label: "text", preview: text, status: "running" });
		}
		this.touch();
	}

	private finishState(state: StepState, status: StepStatus, errorMessage: string | undefined) {
		if (isTerminalStepStatus(state.status)) return;
		if (!state.output) {
			const text = errorMessage ?? "";
			state.finalText = text;
			state.output = this.createStepOutput(state, status, text, [], errorMessage ?? status);
		}
		state.status = status;
		state.endedAt = now();
		state.errorMessage = errorMessage;
		state.controller = undefined;
		this.touch();
		this.appendEvent({ stepId: state.spec.id, type: "step", label: "finish", preview: errorMessage ?? status, status });
		this.emitLifecycle("pi-multiagent:step-finished", { runId: this.id, stepId: state.spec.id, status, agentRef: state.spec.agent.ref, isolation: state.spec.isolation, hasWorktreeEvidence: !!state.worktreeEvidence });
		this.finalizeIfDone();
		if (this.status === "running" && !this.snapshot().terminal) this.queueStepNotice(state, status);
	}

	private finalizeIfDone() {
		if (isTerminalRunStatus(this.status)) return;
		const snapshots = this.stepSnapshots();
		if (snapshots.some((step) => !isTerminalStepStatus(step.status))) return;
		this.status = terminalRunStatus({ currentStatus: this.status, expiryRequested: this.expiryRequested, steps: snapshots });
		this.touch();
		if (this.maxRunTimer) clearTimeout(this.maxRunTimer);
		this.appendEvent({ type: "run", label: "terminal", preview: this.status, status: "done" });
		updatePersistentRunStatus(this.persistent, this.status, true);
		releasePersistentRun(this.persistent);
		this.notifier.sendTerminal(this.status, terminalStepNoticeReasons(snapshots));
		this.emitLifecycle("pi-multiagent:run-completed", { runId: this.id, status: this.status, stepStatuses: Object.fromEntries(snapshots.map((s) => [s.id, s.status])) });
		// Status-specific terminal event (run-succeeded | run-failed | run-canceled | run-timed_out) so a
		// consumer can subscribe to a single outcome without inspecting the run-completed payload.
		this.emitLifecycle(`pi-multiagent:run-${this.status}`, { runId: this.id, status: this.status });
		this.scheduleRetention();
	}

	private expire() {
		if (isTerminalRunStatus(this.status)) return;
		this.expiryRequested = true;
		this.status = "canceling";
		this.touch();
		this.appendEvent({ type: "run", label: "expired", preview: "maxRunSeconds exceeded", status: "error" });
		for (const state of this.states.values()) {
			if (state.status === "pending") this.finishState(state, "canceled", "Run expired pre-start.");
			else if (state.status === "running" && state.controller) state.controller.cancel("Run expired.");
			else if (state.status === "running") this.finishState(state, "timed_out", "Expired before launch.");
		}
		void this.schedule();
	}

	private blockFailedDependents() {
		let changed = false;
		for (const state of this.states.values()) {
			if (state.status !== "pending") continue;
			const failed = state.spec.needs.filter((need) => {
				const dep = this.states.get(need);
				return dep !== undefined && isTerminalStepStatus(dep.status) && dep.status !== "succeeded";
			});
			if (failed.length > 0) {
				this.finishState(state, "blocked", `Dependency failed: ${failed.join(", ")}.`);
				changed = true;
			}
		}
		return changed;
	}

	private blockStalledPendingSteps() {
		for (const state of this.states.values()) {
			if (state.status === "pending") this.finishState(state, "blocked", stalledStepBlockerMessage(state.spec, (id) => this.states.get(id)?.status ?? "missing"));
		}
	}

	private dependenciesReady(step: TeamStepSpec) {
		return step.needs.every((need) => this.states.get(need)?.status === "succeeded") && step.after.every((after) => isTerminalStepStatus(this.states.get(after)?.status ?? "pending"));
	}

	private scheduleRetention() {
		this.retentionTimer = setTimeout(() => {
			try {
				this.cleanup();
				forgetDetachedRun(this.id);
			} catch (error) {
				this.recordDiagnostic("retention-cleanup-failed", "cleanup", error instanceof Error ? error.message : String(error));
			}
		}, this.graph.options.terminalRetentionSeconds * 1000);
		unrefTimer(this.retentionTimer);
	}

	private upstreamArtifactReferences(step: TeamStepSpec): StepArtifactReference[] {
		return [...step.needs, ...step.after].map((stepId) => {
			const state = this.states.get(stepId);
			return { stepId, status: state?.status ?? "missing", filePath: state?.output?.filePath, chars: state?.output?.chars };
		});
	}

	private sinkStepIds() { return findSinkStepIds(this.graph.steps); }
	private lastEventSummary() { return summarizeBackgroundEvent(this.events.last()); }
	private stepSnapshots() { return buildStepSnapshots(this.states.values(), this.stepActivity, this.options.defaults); }
	private counts() { return countStepStatuses(this.states.values()); }

	private appendEvent(input: DetachedRunEventInput) {
		const event = this.events.append(input);
		this.stepActivity.record(event);
		this.waiters.notify(event);
		if (this.status === "running" && input.type === "diagnostic" && input.label !== "agent_team-notice") this.notifier.queueMilestone(`diagnostic:${input.label ?? "event"}`);
		if (this.status === "running" && input.stepId !== undefined && input.type !== "assistant_delta") this.touch();
	}

	private recordDiagnostic(code: string, label: string, message: string) {
		if (!this.diagnostics.some((item) => item.code === code && item.message === message)) this.diagnostics.push({ code, message, path: undefined, severity: "warning" });
		this.appendEvent({ type: "diagnostic", label, preview: message, status: "error" });
	}

	private queueStepNotice(state: StepState, status: StepStatus) {
		if (this.graph.options.notify.mode !== "milestones") return;
		for (const reason of stepNoticeReasons({ stepId: state.spec.id, status, sinkStepIds: this.sinkStepIds() })) this.notifier.queueMilestone(reason);
	}

	private touch() {
		this.updatedAt = now();
		this.runUi(() => this.options.onRunUpdate?.(this.details("run_status")));
	}
}

function runOwnerKey(sessionId: string | undefined): string {
	return sessionId ?? "process";
}

function now(): string {
	return new Date().toISOString();
}

/** Ordered, de-duplicated model lanes to try for a step: the primary model first, then declared
 * fallbacks. Always has at least one entry (the primary, which may be undefined = parent default). */
export function modelCandidates(agent: { model: string | undefined; fallbackModels?: string[] }): (string | undefined)[] {
	const out: (string | undefined)[] = [agent.model];
	const seen = new Set<string>(agent.model === undefined ? [] : [agent.model]);
	for (const fallback of agent.fallbackModels ?? []) {
		if (fallback && !seen.has(fallback)) {
			seen.add(fallback);
			out.push(fallback);
		}
	}
	return out;
}

/** Heuristic: does this step failure look like a model/provider availability error worth retrying on
 * the next fallback model? Broad by design — a false positive only costs one extra attempt that the
 * next model resolves or fails identically; it can never turn a failure into a wrong success. */
export function isRetryableModelError(message: string | undefined): boolean {
	if (!message) return false;
	const text = message.toLowerCase();
	// Strong provider-side throttle/availability signals are retryable on their own, even when the
	// provider error payload never says "model"/"provider"/"deployment" — e.g. Anthropic's
	// {"type":"rate_limit_error","message":"Rate limited"} or a 429/503/529 overloaded_error.
	if (/(rate.?limit|too many requests|overloaded|\b429\b|\b503\b|\b529\b|quota)/.test(text)) return true;
	// Weaker, ambiguous signals require explicit model/provider/deployment context so unrelated task
	// failures that merely contain a word like "invalid" or "not found" are not retried.
	if (!/\b(model|provider|deployment)\b/.test(text)) return false;
	return /(not found|be found|not exist|cannot find|could not find|unknown|unavailable|unsupported|no access|not available|invalid|deprecated|decommission|unauthor|forbidden|permission|rate.?limit|quota|overloaded|capacity|too many requests|\b503\b|\b429\b)/.test(text);
}
