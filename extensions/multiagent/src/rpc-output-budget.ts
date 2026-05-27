/** Retained assistant-output budget for one RPC child step. */

import { MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP, MAX_STEP_OUTPUT_BYTES } from "./types.ts";

const OUTPUT_BUDGET_LABEL = "step-output-budget-exceeded";

export interface OutputBudgetFailure {
	label: typeof OUTPUT_BUDGET_LABEL;
	message: string;
}

export type OutputBudgetCheck = { ok: true; bytes: number } | { ok: false; failure: OutputBudgetFailure };

export interface AssistantOutputBudgetLimits {
	/** Effective per-step byte cap. Clamped to MAX_STEP_OUTPUT_BYTES at construction. */
	maxBytes?: number;
	/** Effective per-step assistant-final-message count cap. Clamped to MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP. */
	maxAssistantFinals?: number;
}

export class AssistantOutputBudget {
	private liveTextBytes = 0;
	private assistantFinalBytes = 0;
	private assistantFinalCount = 0;
	private readonly effectiveMaxBytes: number;
	private readonly effectiveMaxAssistantFinals: number;

	constructor(limits: AssistantOutputBudgetLimits = {}) {
		this.effectiveMaxBytes = clampPositiveInteger(limits.maxBytes, MAX_STEP_OUTPUT_BYTES);
		this.effectiveMaxAssistantFinals = clampPositiveInteger(limits.maxAssistantFinals, MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP);
	}

	resetLiveText(): void {
		this.liveTextBytes = 0;
	}

	appendLiveTextDelta(delta: string): OutputBudgetCheck {
		const nextBytes = this.liveTextBytes + Buffer.byteLength(delta, "utf8");
		if (nextBytes > this.effectiveMaxBytes) return budgetExceeded("assistant text_delta", nextBytes, this.effectiveMaxBytes);
		this.liveTextBytes = nextBytes;
		return { ok: true, bytes: nextBytes };
	}

	measureText(text: string, label: string): OutputBudgetCheck {
		const bytes = Buffer.byteLength(text, "utf8");
		return bytes <= this.effectiveMaxBytes ? { ok: true, bytes } : budgetExceeded(label, bytes, this.effectiveMaxBytes);
	}

	setLiveTextBytes(bytes: number): void {
		this.liveTextBytes = bytes;
	}

	canAcceptAssistantFinal(bytes: number): OutputBudgetFailure | undefined {
		if (this.assistantFinalCount >= this.effectiveMaxAssistantFinals) {
			return { label: OUTPUT_BUDGET_LABEL, message: `step-output-budget-exceeded: Subagent emitted too many non-empty assistant finals; limit=${this.effectiveMaxAssistantFinals}.` };
		}
		const nextBytes = this.assistantFinalBytes + bytes;
		return nextBytes <= this.effectiveMaxBytes ? undefined : budgetExceeded("assistant finals", nextBytes, this.effectiveMaxBytes).failure;
	}

	recordAssistantFinal(bytes: number): void {
		this.assistantFinalCount += 1;
		this.assistantFinalBytes += bytes;
	}

	resetAssistantFinals(): void {
		this.assistantFinalBytes = 0;
		this.assistantFinalCount = 0;
	}

	/** @internal Exposed for unit tests; do not rely on this from production callers. */
	getEffectiveLimits(): { maxBytes: number; maxAssistantFinals: number } {
		return { maxBytes: this.effectiveMaxBytes, maxAssistantFinals: this.effectiveMaxAssistantFinals };
	}
}

function clampPositiveInteger(value: number | undefined, cap: number): number {
	if (value === undefined) return cap;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return cap;
	return Math.min(value, cap);
}

function budgetExceeded(label: string, bytes: number, effectiveCap: number): { ok: false; failure: OutputBudgetFailure } {
	return {
		ok: false,
		failure: {
			label: OUTPUT_BUDGET_LABEL,
			message: `step-output-budget-exceeded: Subagent ${label} would retain ${bytes} bytes; per-step assistant output limit=${effectiveCap} bytes.`,
		},
	};
}
