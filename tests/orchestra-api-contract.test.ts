/** C1 API freeze: a guard test over hb-orchestra's frozen public surfaces. A failure here means a
 * PUBLIC contract changed — that is a deliberate, semver-significant decision (see docs/API.md), not a
 * value to silently update. Update this test + docs/API.md + bump the version when you intend it. */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GRAPH_AUTHORITY_KEYS } from "../extensions/multiagent/src/authority-policy.ts";
import { SUBAGENTS_RPC } from "../extensions/multiagent/src/rpc-bridge.ts";
import { HARNESS_CONTRACT_FILENAMES, HARNESS_SEARCH_PATHS } from "../extensions/orchestra/src/harness-contracts/index.ts";
import { buildReplayManifest } from "../extensions/orchestra/src/reproducibility-ledger/replay-manifest.ts";
import { composedInputsFromGraph, computeRunHash } from "../extensions/orchestra/src/reproducibility-ledger/run-hash.ts";
import type { GraphSpecInput } from "../extensions/multiagent/src/types.ts";

const FIXED_GRAPH: GraphSpecInput = {
	objective: "contract",
	authority: { allowFilesystemRead: true },
	steps: [{ id: "one", agent: { system: "x", tools: ["read", "grep", "find", "ls"] }, task: "t" }],
};

test("run_hash is deterministic and frozen for a fixed graph", () => {
	// Any change to the composed-inputs shape / hashing changes reproducibility for every existing
	// replay manifest. Frozen for v1.0.
	assert.equal(computeRunHash(composedInputsFromGraph(FIXED_GRAPH)), "b4265edf8bed8818f425f66dc7e3a03b44628ad861af21c52f1f36e67c3a7c42");
});

test("replay manifest public field set + schemaVersion are frozen", () => {
	const manifest = buildReplayManifest({ runHash: "h", graph: FIXED_GRAPH });
	assert.deepEqual(Object.keys(manifest).sort(), ["createdAt", "graph", "objective", "runHash", "schemaVersion"]);
	assert.equal(manifest.schemaVersion, 1);
});

test("cross-extension RPC channels are frozen", () => {
	assert.deepEqual({ ...SUBAGENTS_RPC }, { ping: "subagents:rpc:ping", spawn: "subagents:rpc:spawn", stop: "subagents:rpc:stop", reply: "subagents:rpc:reply" });
});

test("harness contract discovery surface is frozen", () => {
	assert.deepEqual([...HARNESS_CONTRACT_FILENAMES], ["contract.json", "harness.json"]);
	assert.deepEqual(
		HARNESS_SEARCH_PATHS.map((entry) => `${entry.relative}:${entry.source}`),
		[".pi/harness:project", ".agents/harness:workspace"],
	);
});

test("graph authority key set is frozen", () => {
	assert.deepEqual([...GRAPH_AUTHORITY_KEYS].sort(), ["allowExtensionCode", "allowFilesystemRead", "allowMutationTools", "allowMutationWorktree", "allowProjectCode", "allowShellTools"]);
});
