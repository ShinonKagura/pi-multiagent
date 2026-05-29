/** Layer 4 (b) harness-apply tests.
 *
 * Pure governance enforcement: the mutation gate and system-prompt injection that
 * `applyContractToGraph` performs at Agent/Profile build time. The fs discovery wrapper
 * (`applyHarnessContract`) and the start-path wiring are exercised by the real-Pi smoke.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { applyContractToGraph, graphRequestsMutation } from "../extensions/orchestra/src/harness-contracts/index.ts";
import type { HarnessContract } from "../extensions/orchestra/src/harness-contracts/index.ts";
import type { GraphSpecInput } from "../extensions/multiagent/src/types.ts";

function contract(over: Partial<HarnessContract> = {}): HarnessContract {
	return { source: "project", sourceDir: "/tmp/h", contractPath: "/tmp/h/contract.json", raw: {}, ...over };
}

function graph(steps: GraphSpecInput["steps"]): GraphSpecInput {
	return { objective: "o", steps };
}

test("graphRequestsMutation: edit/write tools, mutationScope, or worktree isolation count as mutation", () => {
	assert.equal(graphRequestsMutation(graph([{ id: "s", agent: { system: "x", tools: ["read", "grep"] }, task: "t" }])), false);
	assert.equal(graphRequestsMutation(graph([{ id: "s", agent: { system: "x", tools: ["read", "edit"] }, task: "t" }])), true);
	assert.equal(graphRequestsMutation(graph([{ id: "s", agent: { system: "x", tools: ["write"] }, task: "t" }])), true);
	assert.equal(graphRequestsMutation(graph([{ id: "s", agent: { system: "x" }, task: "t", mutationScope: "edit src" }])), true);
	assert.equal(graphRequestsMutation(graph([{ id: "s", agent: { system: "x" }, task: "t", isolation: "worktree" }])), true);
});

test("mutation gate: mutationAllowed=false blocks a mutating run", () => {
	const g = graph([{ id: "s", agent: { system: "x", tools: ["read", "write"] }, task: "t", mutationScope: "write" }]);
	const result = applyContractToGraph(g, contract({ mutationAllowed: false }), "");
	assert.equal(result.blocked, true);
	assert.match(result.reason ?? "", /mutationAllowed=false/);
});

test("mutation gate: mutationAllowed=false allows a read-only run", () => {
	const g = graph([{ id: "s", agent: { system: "x", tools: ["read", "grep"] }, task: "t" }]);
	assert.equal(applyContractToGraph(g, contract({ mutationAllowed: false }), "").blocked, false);
});

test("mutation gate: an unset mutationAllowed never blocks", () => {
	const g = graph([{ id: "s", agent: { system: "x", tools: ["edit"] }, task: "t", mutationScope: "e" }]);
	assert.equal(applyContractToGraph(g, contract({}), "").blocked, false);
});

test("system-prompt injection: appended to inline steps, ref steps untouched", () => {
	const g = graph([
		{ id: "a", agent: { system: "BASE-A" }, task: "t" },
		{ id: "b", agent: { ref: "package:reviewer" }, task: "t" },
	]);
	const result = applyContractToGraph(g, contract(), "PROJECT RULES");
	assert.equal(result.blocked, false);
	assert.equal(result.injectedSystemPrompt, true);
	assert.match(result.graph.steps[0].agent.system ?? "", /BASE-A/);
	assert.match(result.graph.steps[0].agent.system ?? "", /PROJECT RULES/);
	assert.equal(result.graph.steps[1].agent.system, undefined);
	assert.equal(result.graph.steps[1].agent.ref, "package:reviewer");
});

test("system-prompt injection: empty/whitespace injection leaves the graph unchanged", () => {
	const g = graph([{ id: "a", agent: { system: "BASE" }, task: "t" }]);
	const result = applyContractToGraph(g, contract(), "   ");
	assert.equal(result.injectedSystemPrompt, false);
	assert.equal(result.graph.steps[0].agent.system, "BASE");
});
