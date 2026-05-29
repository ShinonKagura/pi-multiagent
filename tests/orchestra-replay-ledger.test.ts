/** Layer 5 (b) replay-ledger store tests.
 *
 * Round-trips the on-disk replay manifest store (write -> load by run_hash, prefix, and recent
 * runId) with an explicit tmp ledger dir (never touches the real state dir). The actual re-launch
 * (`/replay` / `Replay`) is `loadReplayManifest` -> `startRunMaybeWait`, exercised by the real-Pi smoke.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildReplayManifest, loadReplayManifest, writeReplayManifest } from "../extensions/orchestra/src/reproducibility-ledger/index.ts";
import type { GraphSpecInput } from "../extensions/multiagent/src/types.ts";

function ledgerDir(): string {
	return mkdtempSync(join(tmpdir(), "hb-orchestra-replay-ledger-"));
}

function manifestFor(runHash: string, objective = "obj") {
	const graph: GraphSpecInput = { objective, steps: [{ id: "s", agent: { ref: "package:reviewer" }, task: "t" }] };
	return buildReplayManifest({ graph, runHash, createdAt: "2026-05-29T00:00:00Z" });
}

const HASH_A = "a".repeat(64);
const HASH_AB1 = `ab1${"0".repeat(61)}`;
const HASH_AB2 = `ab2${"0".repeat(61)}`;

test("writeReplayManifest + loadReplayManifest: round-trip by full run_hash", () => {
	const dir = ledgerDir();
	const write = writeReplayManifest(manifestFor(HASH_A), "r1", dir);
	assert.equal(write.ok, true);
	const loaded = loadReplayManifest(HASH_A, dir);
	assert.equal(loaded.resolvedBy, "hash");
	assert.equal(loaded.manifest?.runHash, HASH_A);
	assert.equal(loaded.manifest?.graph.steps.length, 1);
});

test("loadReplayManifest: resolves a unique run_hash prefix", () => {
	const dir = ledgerDir();
	writeReplayManifest(manifestFor(HASH_AB1), "r1", dir);
	writeReplayManifest(manifestFor(HASH_AB2), "r2", dir);
	const loaded = loadReplayManifest("ab1", dir);
	assert.equal(loaded.resolvedBy, "hash-prefix");
	assert.equal(loaded.manifest?.runHash, HASH_AB1);
});

test("loadReplayManifest: an ambiguous prefix is a diagnostic, not a guess", () => {
	const dir = ledgerDir();
	writeReplayManifest(manifestFor(HASH_AB1), "r1", dir);
	writeReplayManifest(manifestFor(HASH_AB2), "r2", dir);
	const loaded = loadReplayManifest("ab", dir);
	assert.equal(loaded.manifest, undefined);
	assert.match(loaded.diagnostic ?? "", /ambiguous/);
});

test("loadReplayManifest: resolves a recent runId via the index (last write wins)", () => {
	const dir = ledgerDir();
	writeReplayManifest(manifestFor(HASH_AB1, "first"), "r1", dir);
	writeReplayManifest(manifestFor(HASH_AB2, "second"), "r1", dir); // same runId reused -> newest wins
	const loaded = loadReplayManifest("r1", dir);
	assert.equal(loaded.resolvedBy, "runId");
	assert.equal(loaded.manifest?.runHash, HASH_AB2);
	assert.equal(loaded.manifest?.objective, "second");
});

test("loadReplayManifest: missing id yields a diagnostic and no manifest", () => {
	const dir = ledgerDir();
	const loaded = loadReplayManifest("nope-not-here", dir);
	assert.equal(loaded.manifest, undefined);
	assert.ok((loaded.diagnostic ?? "").length > 0);
});
