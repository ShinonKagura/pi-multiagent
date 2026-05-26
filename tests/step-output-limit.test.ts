/** NEU-B: per-step output budget clamping. */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AssistantOutputBudget } from "../extensions/multiagent/src/rpc-output-budget.ts";
import {
	MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP,
	MAX_STEP_OUTPUT_BYTES,
} from "../extensions/multiagent/src/types.ts";

test("NEU-B: no limits → uses MAX_STEP_OUTPUT_BYTES and MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP", () => {
	const budget = new AssistantOutputBudget();
	const limits = budget.getEffectiveLimits();
	assert.equal(limits.maxBytes, MAX_STEP_OUTPUT_BYTES);
	assert.equal(
		limits.maxAssistantFinals,
		MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP,
	);
});

test("NEU-B: custom maxBytes clamps live text delta", () => {
	const budget = new AssistantOutputBudget({ maxBytes: 1024 });
	const result = budget.appendLiveTextDelta("a".repeat(1025));
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.failure.message.includes("1024"));
});

test("NEU-B: custom maxAssistantFinals limits final-message count", () => {
	const budget = new AssistantOutputBudget({ maxAssistantFinals: 2 });
	budget.recordAssistantFinal(100);
	budget.recordAssistantFinal(100);
	const failure = budget.canAcceptAssistantFinal(100);
	assert.ok(failure, "third assistant final should be denied when limit=2");
	assert.ok(failure!.message.includes("2"));
});

test("NEU-B: oversize maxBytes clamps DOWN to MAX_STEP_OUTPUT_BYTES", () => {
	const budget = new AssistantOutputBudget({ maxBytes: 999_999_999 });
	assert.equal(budget.getEffectiveLimits().maxBytes, MAX_STEP_OUTPUT_BYTES);
});

test("NEU-B: invalid maxBytes (negative, NaN) falls back to default", () => {
	const negative = new AssistantOutputBudget({ maxBytes: -1 });
	assert.equal(negative.getEffectiveLimits().maxBytes, MAX_STEP_OUTPUT_BYTES);
	const nan = new AssistantOutputBudget({ maxBytes: Number.NaN });
	assert.equal(nan.getEffectiveLimits().maxBytes, MAX_STEP_OUTPUT_BYTES);
});

test("NEU-B: budget exceeded message includes the effective cap (not the global)", () => {
	const budget = new AssistantOutputBudget({ maxBytes: 512 });
	const result = budget.appendLiveTextDelta("a".repeat(513));
	assert.equal(result.ok, false);
	if (!result.ok) assert.ok(result.failure.message.includes("512"));
});
