import assert from "node:assert/strict";
import { test } from "node:test";

import { AssistantOutputBudget } from "../extensions/multiagent/src/rpc-output-budget.ts";
import { MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP, MAX_STEP_OUTPUT_BYTES } from "../extensions/multiagent/src/types.ts";

test("AssistantOutputBudget falls back to package caps when no limits are provided", () => {
	const budget = new AssistantOutputBudget();
	assert.deepEqual(budget.getEffectiveLimits(), { maxBytes: MAX_STEP_OUTPUT_BYTES, maxAssistantFinals: MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP });
});

test("AssistantOutputBudget honors per-step maxBytes below the package cap", () => {
	const budget = new AssistantOutputBudget({ maxBytes: 32 });
	assert.equal(budget.getEffectiveLimits().maxBytes, 32);
	const within = budget.appendLiveTextDelta("a".repeat(32));
	assert.equal(within.ok, true);
	const over = budget.measureText("a".repeat(33), "test");
	assert.equal(over.ok, false);
	if (!over.ok) assert.match(over.failure.message, /limit=32 bytes/);
});

test("AssistantOutputBudget clamps maxBytes upward attempts back to the package cap", () => {
	const budget = new AssistantOutputBudget({ maxBytes: MAX_STEP_OUTPUT_BYTES * 10 });
	assert.equal(budget.getEffectiveLimits().maxBytes, MAX_STEP_OUTPUT_BYTES);
});

test("AssistantOutputBudget clamps maxAssistantFinals upward attempts back to the package cap", () => {
	const budget = new AssistantOutputBudget({ maxAssistantFinals: MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP * 10 });
	assert.equal(budget.getEffectiveLimits().maxAssistantFinals, MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP);
});

test("AssistantOutputBudget honors per-step maxAssistantFinals below the package cap", () => {
	const budget = new AssistantOutputBudget({ maxAssistantFinals: 2 });
	assert.equal(budget.getEffectiveLimits().maxAssistantFinals, 2);
	assert.equal(budget.canAcceptAssistantFinal(10), undefined);
	budget.recordAssistantFinal(10);
	assert.equal(budget.canAcceptAssistantFinal(10), undefined);
	budget.recordAssistantFinal(10);
	const denied = budget.canAcceptAssistantFinal(10);
	assert.notEqual(denied, undefined);
	if (denied) assert.match(denied.message, /limit=2/);
});

test("canAcceptAssistantFinal denies when cumulative byte total would exceed effective maxBytes", () => {
	const budget = new AssistantOutputBudget({ maxBytes: 20 });
	assert.equal(budget.canAcceptAssistantFinal(15), undefined);
	budget.recordAssistantFinal(15);
	const denied = budget.canAcceptAssistantFinal(15);
	assert.notEqual(denied, undefined, "second 15-byte final must be denied when total would be 30 > 20");
	if (denied) assert.match(denied.message, /limit=20 bytes/);
});

test("AssistantOutputBudget ignores invalid limit inputs and falls back to package cap", () => {
	for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		const byteBudget = new AssistantOutputBudget({ maxBytes: bad });
		assert.equal(byteBudget.getEffectiveLimits().maxBytes, MAX_STEP_OUTPUT_BYTES, `maxBytes=${bad} must fall back to package cap`);
		const finalsBudget = new AssistantOutputBudget({ maxAssistantFinals: bad });
		assert.equal(finalsBudget.getEffectiveLimits().maxAssistantFinals, MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP, `maxAssistantFinals=${bad} must fall back to package cap`);
	}
});
