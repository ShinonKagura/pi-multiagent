/** Layer 6 foreground-wait clamp tests.
 *
 * `Agent`/`Profile` accept an optional `waitSeconds` for a bounded foreground wait. The clamp keeps
 * the wait window finite (ARCHITECTURE I1: never trap the parent on hung child compute). The live
 * start->poll loop is exercised by the real-Pi smoke; this covers the pure bound.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { clampForegroundWaitSeconds } from "../extensions/orchestra/index.ts";

test("clampForegroundWaitSeconds: undefined stays undefined (detached, no wait)", () => {
	assert.equal(clampForegroundWaitSeconds(undefined), undefined);
});

test("clampForegroundWaitSeconds: sub-1 / invalid values disable the wait", () => {
	assert.equal(clampForegroundWaitSeconds(0), undefined);
	assert.equal(clampForegroundWaitSeconds(-5), undefined);
	assert.equal(clampForegroundWaitSeconds(Number.NaN), undefined);
	assert.equal(clampForegroundWaitSeconds(Number.POSITIVE_INFINITY), undefined);
});

test("clampForegroundWaitSeconds: in-range values are floored", () => {
	assert.equal(clampForegroundWaitSeconds(1), 1);
	assert.equal(clampForegroundWaitSeconds(42.9), 42);
});

test("clampForegroundWaitSeconds: hard cap at 600s (I1: bounded)", () => {
	assert.equal(clampForegroundWaitSeconds(600), 600);
	assert.equal(clampForegroundWaitSeconds(5000), 600);
});
