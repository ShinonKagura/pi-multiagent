/** Layer 5 (reproducibility-ledger) tests.
 *
 * Scope: the pure run-hash + replay-manifest primitives. The start-path emission/append is exercised
 * by the real-Pi smoke.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { appendRunHashNote } from "../extensions/orchestra/index.ts";
import { buildReplayManifest, canonicalJson, composedInputsFromGraph, computeRunHash, RUN_HASH_VERSION } from "../extensions/orchestra/src/reproducibility-ledger/index.ts";
import type { AgentTeamDetails } from "../extensions/multiagent/src/types.ts";
import type { GraphSpecInput } from "../extensions/multiagent/src/types.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

function graph(): GraphSpecInput {
	return {
		objective: "Review the diff",
		authority: { allowFilesystemRead: true },
		steps: [{ id: "reviewer", agent: { system: "You review.", tools: ["read", "grep"], model: "anthropic/claude-sonnet-4-5", thinking: "medium" }, task: "Review it" }],
	};
}

test("computeRunHash: deterministic for identical inputs (64-hex sha256)", () => {
	const a = computeRunHash(composedInputsFromGraph(graph()));
	const b = computeRunHash(composedInputsFromGraph(graph()));
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{64}$/);
});

test("computeRunHash: changes when any composed input changes", () => {
	const base = computeRunHash(composedInputsFromGraph(graph()));
	const taskChanged = graph();
	taskChanged.steps[0].task = "Review it differently";
	assert.notEqual(base, computeRunHash(composedInputsFromGraph(taskChanged)));
	const modelChanged = graph();
	modelChanged.steps[0].agent.model = "openai/gpt-4o";
	assert.notEqual(base, computeRunHash(composedInputsFromGraph(modelChanged)));
});

test("canonicalJson: stable regardless of object key insertion order", () => {
	assert.equal(canonicalJson({ a: 1, b: { x: 1, y: 2 } }), canonicalJson({ b: { y: 2, x: 1 }, a: 1 }));
});

test("composedInputsFromGraph: maps inline system, ref, and step fields", () => {
	const g: GraphSpecInput = {
		objective: "obj",
		steps: [
			{ id: "one", agent: { system: "sys", tools: ["read"], model: "m", thinking: "low" }, task: "t1", mutationScope: "edit src" },
			{ id: "two", agent: { ref: "package:reviewer" }, task: "t2" },
		],
	};
	const inputs = composedInputsFromGraph(g, "harness-abc");
	assert.equal(inputs.objective, "obj");
	assert.equal(inputs.steps[0].agent, "sys");
	assert.deepEqual(inputs.steps[0].tools, ["read"]);
	assert.equal(inputs.steps[0].mutationScope, "edit src");
	assert.equal(inputs.steps[1].agent, "ref:package:reviewer");
	assert.equal(inputs.harnessContractHash, "harness-abc");
});

test("computeRunHash: the harness contract hash folds into the fingerprint", () => {
	const without = computeRunHash(composedInputsFromGraph(graph()));
	const withHarness = computeRunHash(composedInputsFromGraph(graph(), "harness-xyz"));
	assert.notEqual(without, withHarness);
});

test("appendRunHashNote: appends a run_hash text part, preserving existing content", () => {
	const result = { content: [{ type: "text", text: "started" }], details: { ok: true } } as unknown as AgentToolResult<AgentTeamDetails>;
	const out = appendRunHashNote(result, "deadbeefcafe");
	assert.equal(out.content?.length, 2);
	assert.equal(out.content?.[0]?.type === "text" ? out.content[0].text : "", "started");
	assert.match(out.content?.[1]?.type === "text" ? out.content[1].text : "", /run_hash=deadbeefcafe/);
});

test("buildReplayManifest: serializable descriptor carrying run hash + full graph", () => {
	const g = graph();
	const runHash = computeRunHash(composedInputsFromGraph(g));
	const manifest = buildReplayManifest({ graph: g, runHash, createdAt: "2026-05-29T00:00:00Z" });
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.runHash, runHash);
	assert.equal(manifest.objective, "Review the diff");
	assert.deepEqual(manifest.graph, g);
	assert.ok(RUN_HASH_VERSION.startsWith("hb-orchestra-run-hash"));
});
