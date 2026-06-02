import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AssistantOutputBudget, type OutputBudgetFailure } from "./rpc-output-budget.ts";
import { RpcCommandQueue, type RpcCommandAck } from "./rpc-command-queue.ts";
import { combinedAssistantFinals, envelopeParentMessage, extractAgentEndErrorMessage, extractAgentEndStopReason, extractAssistantErrorMessage, extractAssistantStopReason, extractAssistantText, extractEventText, hasAgentEndErrorMetadata, isAgentEndContextOverflow, isContextOverflowStop, stringField } from "./rpc-record-utils.ts";
import { STDERR_PREVIEW_CHARS, type StepStatus } from "./types.ts";
import { buildPiArgs, getPiInvocation, killProcessTree, type SpawnProcess } from "./child-launch.ts";
import { type RpcJsonRecord } from "./rpc-jsonl.ts";
import { RpcChildListeners } from "./rpc-child-listeners.ts";
import { handleUnattendedUiRequest } from "./rpc-ui-request.ts";
import { ParentMessageBudget } from "./rpc-parent-message-budget.ts";
import { handleAssistantMessageUpdate } from "./rpc-message-update.ts";
import { terminateRpcChild } from "./rpc-child-termination.ts";
import { firstNonBlank, toolErrorPreview } from "./rpc-tool-events.ts";
import type { RpcChildControllerOptions, RpcStepResult } from "./rpc-child-types.ts";

// Window for a child to ACCEPT the `prompt` command (controller.run sends it immediately after
// spawn, with no readiness handshake), so this must cover the child's ENTIRE pi startup: process
// bootstrap + extension load + model-client/provider init, before it can read stdin and ack. 10s was
// far too tight for a heavyweight pi child under concurrent spawn load (model init + cold caches),
// causing uniform `RPC command prompt timed out waiting for response` failures with chars=0 even
// though the children were healthy. The ack resolves the instant the child accepts, so a generous
// ceiling is essentially free on the happy path; truly-stuck children still fail via exit/close/stderr
// and the per-step timeoutSecondsPerStep. This is the prompt-accept window, NOT a per-turn limit.
export const ACK_TIMEOUT_MS = 120_000;
const EXIT_CLOSE_GRACE_MS = 500;

export class RpcChildController {
	private readonly options: RpcChildControllerOptions;
	private readonly commands: RpcCommandQueue;
	private child: ChildProcessWithoutNullStreams | undefined;
	private completionResolve: ((result: RpcStepResult) => void) | undefined;
	private closingResult: RpcStepResult | undefined;
	private finalized = false;
	private terminating = false;
	private childClosed = false;
	private childExited = false;
	private sawAgentEnd = false;
	private agentEndStopReason: string | undefined;
	private agentEndErrorMessage: string | undefined;
	private lastAssistantStopReason: string | undefined;
	private lastAssistantErrorMessage: string | undefined;
	private recoveringOverflow = false;
	private output = "";
	private assistantFinals: string[] = [];
	private readonly outputBudget: AssistantOutputBudget;
	private liveText = "";
	private stderr = "";
	private readonly parentMessageBudget = new ParentMessageBudget();
	private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	private killTimer: ReturnType<typeof setTimeout> | undefined;
	private exitCloseTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly listeners = new RpcChildListeners();
	private spawnProcess: SpawnProcess;

	constructor(options: RpcChildControllerOptions) {
		this.options = options;
		this.spawnProcess = options.spawnProcess ?? spawn;
		this.outputBudget = new AssistantOutputBudget({ maxBytes: options.outputLimit?.maxBytes, maxAssistantFinals: options.outputLimit?.maxAssistantFinals });
		const ackTimeoutMs = Number.isFinite(options.ackTimeoutMs) && options.ackTimeoutMs !== undefined && options.ackTimeoutMs > 0 ? Math.trunc(options.ackTimeoutMs) : ACK_TIMEOUT_MS;
		this.commands = new RpcCommandQueue(ackTimeoutMs);
	}

	async run(task: string): Promise<RpcStepResult> {
		const args = buildPiArgs(this.options.agent, this.options.defaults, this.options.promptPath);
		const invocation = getPiInvocation(args, this.options.cwd);
		this.child = this.spawnProcess(invocation.command, invocation.args, { cwd: this.options.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
		// FIX-6: detached children must be .unref()'d so the parent Pi process can exit
		// after `pi -p` returns its final response. Without this, libuv keeps the parent
		// event loop alive waiting on the child handle even after the child has exited
		// and stdio has closed. Symptom: `pi -p` hangs at the shell prompt after the
		// model's terminal JSON. Exit/close/stderr listeners still fire after unref().
		this.child.unref?.();
		this.options.onEvent({ type: "rpc", label: "spawn", preview: "child spawned", status: "running" });
		this.listeners.attach(this.child, { onRecord: (record) => this.handleRecord(record), onStdoutError: (message) => this.handleStdoutError(message), onStderrData: (text) => this.appendStderr(text), onStderrError: (error) => this.handleStderrError(error), onStdinError: (error) => this.handleStdinError(error), onChildError: (error) => this.fail("failed", `Subagent process error: ${error.message}`), onExit: () => this.handleExit(), onClose: () => this.handleClose() });
		this.timeoutTimer = setTimeout(() => this.fail("timed_out", this.recoveringOverflow ? `context-overflow-unrecovered: timeoutSecondsPerStep=${this.options.limits.timeoutSecondsPerStep} exceeded before a valid post-recovery assistant final.` : `timeoutSecondsPerStep=${this.options.limits.timeoutSecondsPerStep} exceeded.`, this.recoveringOverflow ? "context-overflow-unrecovered" : "timed_out"), this.options.limits.timeoutSecondsPerStep * 1000);
		this.timeoutTimer.unref?.();
		const completion = new Promise<RpcStepResult>((resolve) => {
			this.completionResolve = resolve;
		});
		this.options.onEvent({ type: "rpc", label: "prompt", preview: "sent", status: "running" });
		const ack = await this.sendCommand({ type: "prompt", message: task });
		if (!ack.success) this.fail("failed", ack.error ?? "Prompt rejected.");
		else this.options.onEvent({ type: "rpc", label: "prompt", preview: "accepted", status: "done" });
		return completion;
	}

	async message(channel: "steer" | "follow_up", text: string): Promise<RpcCommandAck> {
		if (this.finalized || this.closingResult || this.terminating) return { success: false, error: "Step is not live." };
		const budgetError = this.parentMessageBudget.reserve(text);
		if (budgetError) return { success: false, error: budgetError };
		const commandType = channel === "steer" ? "steer" : "follow_up";
		const ack = await this.sendCommand({ type: commandType, message: envelopeParentMessage(channel, text) });
		this.options.onEvent({ type: "parent_message", label: channel, preview: ack.success ? "accepted for delivery" : ack.error, status: ack.success ? "done" : "error" });
		this.maybeFinalize();
		return ack;
	}

	cancel(reason: string | undefined): void {
		if (this.finalized || this.closingResult) return;
		this.options.onEvent({ type: "diagnostic", label: "cancel", preview: reason ?? "cancel requested", status: "running" });
		void this.sendCommand({ type: "abort" });
		this.fail("canceled", reason ?? "Run canceled.");
	}

	forceKill(reason: string): void {
		if (!this.child || this.childClosed || this.childExited) return;
		if (this.killTimer) clearTimeout(this.killTimer);
		this.options.onEvent({ type: "diagnostic", label: "SIGKILL", preview: reason, status: "error" });
		if (!killProcessTree(this.child, "SIGKILL")) this.options.onEvent({ type: "diagnostic", label: "SIGKILL", preview: "not accepted", status: "error" });
		if (this.closingResult) this.complete(this.closingResult);
	}

	private handleStdoutError(message: string): void {
		const normalized = message.startsWith("RPC JSONL stream error:") ? message.replace("RPC JSONL", "RPC stdout") : message;
		this.fail("failed", normalized, normalized.includes("stream error") ? "stdout-error" : "rpc-jsonl");
	}

	private handleStdinError(error: Error): void {
		const message = `RPC stdin stream error: ${error.message}`;
		if (this.finalized) return;
		if (this.closingResult) {
			this.options.onEvent({ type: "diagnostic", label: "stdin-error", preview: message, status: "error" });
			return;
		}
		this.fail("failed", message, "stdin-error");
	}

	private handleStderrError(error: Error): void {
		const message = `RPC stderr stream error: ${error.message}`;
		if (this.finalized) return;
		if (this.closingResult) {
			this.options.onEvent({ type: "diagnostic", label: "stderr-error", preview: message, status: "error" });
			return;
		}
		this.fail("failed", message, "stderr-error");
	}

	private sendCommand(command: RpcJsonRecord): Promise<RpcCommandAck> {
		if (this.finalized || this.closingResult) return Promise.resolve({ success: false, error: "RPC child is not live." });
		return this.commands.send(this.child?.stdin, command);
	}

	private handleRecord(record: RpcJsonRecord): void {
		if (this.finalized || this.closingResult) return;
		const type = typeof record.type === "string" ? record.type : "unknown";
		if (type === "response") {
			this.handleResponse(record);
			return;
		}
		if (type === "message_update") this.handleMessageUpdate(record);
		else if (type === "message_end") this.handleMessageEnd(record);
		else if (type === "agent_end") this.handleAgentEnd(record);
		else if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") this.handleToolEvent(type, record);
		else if (type === "extension_ui_request") this.handleUiRequest(record);
		else if (type === "extension_error") this.options.onEvent({ type: "diagnostic", label: "extension_error", preview: extractEventText(record), status: "error" });
		else this.options.onEvent({ type: "rpc", label: type, preview: extractEventText(record) });
	}

	private handleResponse(record: RpcJsonRecord): void {
		this.commands.handleResponse(record, ({ command, message }) => this.options.onEvent({ type: "diagnostic", label: command, preview: message, status: "error" }));
		this.maybeFinalize();
	}

	private handleAgentEnd(record: RpcJsonRecord): void {
		this.sawAgentEnd = true;
		this.agentEndStopReason = extractAgentEndStopReason(record);
		this.agentEndErrorMessage = extractAgentEndErrorMessage(record);
		const preview = this.agentEndStopReason ? `stopReason=${this.agentEndStopReason}` : "terminal event";
		const suffix = this.agentEndErrorMessage ? `: ${this.agentEndErrorMessage}` : "";
		this.options.onEvent({ type: "rpc", label: "agent_end", preview: `${preview}${suffix}`, status: "done" });
		if (isAgentEndContextOverflow(record)) {
			this.enterContextOverflowRecovery("agent_end", this.agentEndErrorMessage ?? extractEventText(record));
			return;
		}
		if (hasAgentEndErrorMetadata(record) && (!this.agentEndStopReason || this.agentEndStopReason === "stop")) this.agentEndStopReason = "error";
		this.maybeFinalize();
	}

	private handleMessageUpdate(record: RpcJsonRecord): void {
		this.liveText = handleAssistantMessageUpdate(record, { liveText: this.liveText, outputBudget: this.outputBudget, failOutputBudget: (failure) => this.failOutputBudget(failure), onText: this.options.onText, onEvent: this.options.onEvent });
	}

	private handleMessageEnd(record: RpcJsonRecord): void {
		const text = extractAssistantText(record);
		const stopReason = extractAssistantStopReason(record);
		const errorMessage = extractAssistantErrorMessage(record);
		this.lastAssistantStopReason = stopReason;
		this.lastAssistantErrorMessage = errorMessage;
		if (isContextOverflowStop(stopReason, errorMessage, extractEventText(record))) {
			this.enterContextOverflowRecovery("assistant", errorMessage ?? extractEventText(record));
			return;
		}
		if (text === undefined) return;
		const check = this.outputBudget.measureText(text, "assistant final");
		if (!check.ok) {
			this.failOutputBudget(check.failure);
			return;
		}
		const nonEmpty = text.trim().length > 0;
		const finalFailure = nonEmpty ? this.outputBudget.canAcceptAssistantFinal(check.bytes) : undefined;
		if (finalFailure) {
			this.failOutputBudget(finalFailure);
			return;
		}
		this.output = text;
		this.liveText = text;
		this.outputBudget.setLiveTextBytes(check.bytes);
		this.options.onText?.(text);
		if (!nonEmpty) {
			this.options.onEvent({ type: "rpc", label: "assistant_final_empty", preview: "empty assistant final ignored", status: "done" });
			return;
		}
		if (stopReason && stopReason !== "stop") {
			const message = errorMessage ? `assistant message ended with stopReason ${stopReason}: ${errorMessage}` : `assistant message ended with stopReason ${stopReason}`;
			this.options.onEvent({ type: "rpc", label: "assistant_nonfinal", preview: message, status: stopReason === "tooluse" ? "done" : "error" });
			return;
		}
		this.outputBudget.recordAssistantFinal(check.bytes);
		this.assistantFinals.push(text);
		this.options.onEvent({ type: "assistant_final", label: "assistant", preview: text, status: "done" });
	}

	private failOutputBudget(failure: OutputBudgetFailure): void {
		this.fail("failed", failure.message, failure.label);
	}

	private handleToolEvent(type: string, record: RpcJsonRecord): void {
		const name = stringField(record.toolName) ?? "tool";
		const isEnd = type === "tool_execution_end";
		const isError = isEnd && record.isError === true;
		const status = isEnd ? (isError ? "error" : "done") : "running";
		const preview = isError ? toolErrorPreview(record) : type.replace("tool_execution_", "");
		this.options.onEvent({ type: "tool", label: name, preview, status });
	}

	private handleUiRequest(record: RpcJsonRecord): void {
		handleUnattendedUiRequest({ record, child: this.child, finalized: this.finalized, onEvent: this.options.onEvent, onDenied: (message) => this.fail("failed", message) });
	}

	private maybeFinalize(): void {
		if (!this.sawAgentEnd || this.commands.pendingCount > 0 || this.finalized || this.closingResult) return;
		const stopReason = this.agentEndStopReason ?? this.lastAssistantStopReason;
		const errorMessage = this.agentEndErrorMessage ?? this.lastAssistantErrorMessage;
		if (stopReason && stopReason !== "stop") {
			const message = errorMessage ? `Subagent RPC ended with stopReason ${stopReason}: ${errorMessage}` : `Subagent RPC ended with stopReason ${stopReason}.`;
			this.fail("failed", message, stopReason === "error" ? "assistant-error" : "assistant-stop");
			return;
		}
		const text = combinedAssistantFinals(this.assistantFinals);
		if (text.trim().length === 0) {
			if (this.recoveringOverflow) {
				this.fail("failed", "context-overflow-unrecovered: child reported context overflow but did not produce a valid post-recovery assistant final.", "context-overflow-unrecovered");
				return;
			}
			this.fail("failed", "assistant-final-empty: no assistant final text captured after agent_end and command ACKs.", "assistant-final-empty");
			return;
		}
		this.finalize({ status: "succeeded", text, assistantFinals: [...this.assistantFinals], stderr: this.stderr, errorMessage: undefined });
	}

	private failureResult(status: StepStatus, message: string): RpcStepResult {
		const assistantFinals = [...this.assistantFinals];
		const nonFinalText = assistantFinals.length === 0 ? firstNonBlank(this.output, this.liveText) : undefined;
		return { status, text: this.output, assistantFinals, stderr: this.stderr, errorMessage: message, ...(nonFinalText ? { nonFinalText } : {}) };
	}

	private enterContextOverflowRecovery(label: string, message: string): void {
		if (this.finalized || this.closingResult) return;
		this.recoveringOverflow = true;
		this.sawAgentEnd = false;
		this.agentEndStopReason = undefined;
		this.agentEndErrorMessage = undefined;
		this.lastAssistantStopReason = undefined;
		this.lastAssistantErrorMessage = undefined;
		this.output = "";
		this.liveText = "";
		this.assistantFinals = [];
		this.outputBudget.resetLiveText();
		this.outputBudget.resetAssistantFinals();
		this.options.onText?.(this.liveText);
		this.options.onEvent({ type: "diagnostic", label: "context_overflow_recovering", preview: `recovering after ${label}: ${message}`, status: "running" });
	}

	private fail(status: StepStatus, message: string, label: string = status): void {
		if (this.finalized || this.closingResult) return;
		this.options.onEvent({ type: "diagnostic", label, preview: message, status: "error" });
		this.finalize(this.failureResult(status, message));
	}

	private finalize(result: RpcStepResult): void {
		if (this.finalized || this.closingResult) return;
		this.closingResult = result;
		this.options.onEvent({ type: "rpc", label: "terminalizing", preview: result.status, status: "running" });
		if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
		this.commands.closeWith((command) => `RPC command ${command} closed by finalization.`);
		this.listeners.detachIo(false, true);
		this.terminateChild();
		if (!this.child || this.childClosed || this.childExited || this.child.exitCode !== null) this.complete(result);
	}

	private handleExit(): void {
		this.childExited = true;
		if (this.childClosed || this.finalized) return;
		this.exitCloseTimer = setTimeout(() => {
			if (this.childClosed || this.finalized) return;
			if (this.closingResult) {
				this.options.onEvent({ type: "diagnostic", label: "process-exit", preview: `stdio close open ${EXIT_CLOSE_GRACE_MS}ms after exit; closeout forced`, status: "error" });
				this.complete(this.closingResult);
				return;
			}
			this.fail("failed", this.recoveringOverflow ? "context-overflow-unrecovered: child process exited before a valid post-recovery assistant final." : "Subagent process exited before terminal agent_end.", this.recoveringOverflow ? "context-overflow-unrecovered" : "failed");
		}, EXIT_CLOSE_GRACE_MS);
		this.exitCloseTimer.unref?.();
	}

	private handleClose(): void {
		this.childClosed = true;
		if (this.killTimer) clearTimeout(this.killTimer);
		if (this.exitCloseTimer) clearTimeout(this.exitCloseTimer);
		if (this.closingResult) {
			this.complete(this.closingResult);
			return;
		}
		if (!this.finalized) this.fail("failed", this.recoveringOverflow ? "context-overflow-unrecovered: child closed before a valid post-recovery assistant final." : "Subagent closed before agent_end.", this.recoveringOverflow ? "context-overflow-unrecovered" : "failed");
	}

	private complete(result: RpcStepResult): void {
		if (this.finalized) return;
		this.finalized = true;
		if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
		if (this.killTimer) clearTimeout(this.killTimer);
		if (this.exitCloseTimer) clearTimeout(this.exitCloseTimer);
		this.listeners.detachForCompletion(!!this.child && !this.childClosed);
		this.completionResolve?.(result);
		this.completionResolve = undefined;
	}

	private terminateChild(): void {
		terminateRpcChild({ child: this.child, isTerminating: () => this.terminating, markTerminating: () => { this.terminating = true; }, isChildClosed: () => this.childClosed, isChildExited: () => this.childExited, closingResult: () => this.closingResult, setKillTimer: (timer) => { this.killTimer = timer; }, onEvent: this.options.onEvent, complete: (result) => this.complete(result) });
	}

	private appendStderr(text: string): void {
		if (text.length === 0) return;
		this.stderr = `${this.stderr}${text}`;
		if (this.stderr.length > STDERR_PREVIEW_CHARS) this.stderr = this.stderr.slice(this.stderr.length - STDERR_PREVIEW_CHARS);
	}
}
