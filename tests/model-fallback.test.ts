/** B1 runtime model-fallback: unit coverage for the decision helpers.
 *
 * modelCandidates builds the ordered try-list (primary + fallbacks); isRetryableModelError decides
 * whether a failed step should retry on the next lane. The end-to-end retry (DetachedRun executing a
 * step against a model-error-then-success fake child) is covered by model-fallback-e2e.test.ts.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isRetryableModelError, modelCandidates } from "../extensions/multiagent/src/detached-run.ts";

test("modelCandidates: primary only when no fallbacks", () => {
	assert.deepEqual(modelCandidates({ model: "a" }), ["a"]);
	assert.deepEqual(modelCandidates({ model: undefined }), [undefined]);
});

test("modelCandidates: primary then fallbacks, de-duplicated, order preserved", () => {
	assert.deepEqual(modelCandidates({ model: "a", fallbackModels: ["b", "c"] }), ["a", "b", "c"]);
	assert.deepEqual(modelCandidates({ model: "a", fallbackModels: ["a", "b", "b", "c"] }), ["a", "b", "c"]);
	assert.deepEqual(modelCandidates({ model: undefined, fallbackModels: ["b"] }), [undefined, "b"]);
});

test("isRetryableModelError: matches model/provider availability failures", () => {
	assert.equal(isRetryableModelError("Subagent RPC ended with stopReason error: model gpt-x is not available"), true);
	assert.equal(isRetryableModelError("the model could not be found"), true);
	assert.equal(isRetryableModelError("provider returned 429 rate limit"), true);
	assert.equal(isRetryableModelError("model provider unauthorized"), true);
	assert.equal(isRetryableModelError("deployment overloaded"), true);
});

test("isRetryableModelError: does not match non-model failures", () => {
	assert.equal(isRetryableModelError(undefined), false);
	assert.equal(isRetryableModelError("assistant-final-empty: no assistant final text captured"), false);
	assert.equal(isRetryableModelError("the file was not found"), false);
	assert.equal(isRetryableModelError("step timed out"), false);
});
