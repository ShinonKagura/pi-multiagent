/** OPEN-2 runId namespace seeding test.
 *
 * Covers the pure helper that decides how far to advance the process-local runId serial so a fresh
 * process never reuses a runId still persisted on disk (which would collide in createPersistentRun).
 * The lazy disk seed + end-to-end no-collision behavior is exercised by the real-Pi smoke.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { highestPersistedRunIdSerial } from "../extensions/multiagent/src/delegation.ts";

test("highestPersistedRunIdSerial: 0 for no persisted runs", () => {
	assert.equal(highestPersistedRunIdSerial([]), 0);
});

test("highestPersistedRunIdSerial: returns the max rN serial", () => {
	assert.equal(highestPersistedRunIdSerial(["r1", "r5", "r3"]), 5);
	assert.equal(highestPersistedRunIdSerial(["r18", "r2", "r9"]), 18);
});

test("highestPersistedRunIdSerial: ignores non-rN ids and keeps the numeric max", () => {
	assert.equal(highestPersistedRunIdSerial(["r1", "rX", "foo", "r0", "r12", ""]), 12);
});

test("highestPersistedRunIdSerial: large serials are handled", () => {
	assert.equal(highestPersistedRunIdSerial(["r999999", "r7"]), 999999);
});
