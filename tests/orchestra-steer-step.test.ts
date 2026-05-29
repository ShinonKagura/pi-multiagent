/** Layer 6 steer-step resolution tests.
 *
 * `steer_subagent` wraps agent_team `message`, which requires a valid stepId. When the caller
 * omits stepId, the wrapper auto-resolves it from the run's live steps. This covers that pure
 * resolution logic (the live runAgentTeam round-trip is exercised by the real-Pi smoke).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveSteerStepId } from "../extensions/orchestra/index.ts";

test("resolveSteerStepId: an explicit stepId is honored as-is", () => {
	assert.deepEqual(resolveSteerStepId(["a", "b"], "b"), { stepId: "b" });
});

test("resolveSteerStepId: a single live step auto-resolves", () => {
	assert.deepEqual(resolveSteerStepId(["only"], undefined), { stepId: "only" });
});

test("resolveSteerStepId: no live step is a steer-no-live-step error", () => {
	const r = resolveSteerStepId([], undefined);
	assert.equal(r.stepId, undefined);
	assert.equal(r.error?.code, "steer-no-live-step");
});

test("resolveSteerStepId: multiple live steps require an explicit stepId", () => {
	const r = resolveSteerStepId(["x", "y"], undefined);
	assert.equal(r.stepId, undefined);
	assert.equal(r.error?.code, "steer-ambiguous-step");
	assert.match(r.error?.message ?? "", /x, y/);
});
