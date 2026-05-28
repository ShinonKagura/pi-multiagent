/** PRE regression: preflight current-shape repairs must not preserve legacy contracts. */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { validatePreflightShape } from "../extensions/multiagent/src/preflight-shape.ts";
import { AgentTeamSchema } from "../extensions/multiagent/src/schemas.ts";

const validate = Compile(AgentTeamSchema);

test("PRE: mixed malformed start repair only mentions current graph fields", () => {
	const diagnostics = validatePreflightShape({
		action: "start",
		objective: "x",
		steps: [{ id: "a", agent: { system: "s" }, task: "t" }],
		agents: [{ id: "legacy" }],
		synthesis: { task: "legacy" },
		outputContract: "legacy",
		callerSkills: ["legacy"],
	});
	const denied = diagnostics.find((d) => d.code === "start-control-fields-denied");
	assert.ok(denied, "top-level objective/steps should produce start-control-fields-denied");
	assert.deepEqual(denied.fields, ["objective", "steps"]);
	assert.ok(denied.repair?.includes("Move graph body fields under graph"));
	assert.equal(denied.repair?.includes("agents"), false);
	assert.equal(denied.repair?.includes("synthesis"), false);
	assert.equal(denied.repair?.includes("outputContract"), false);
	assert.equal(denied.repair?.includes("callerSkills"), false);
});

test("PRE: legitimate graph-body misplacement (objective at top) still gets repair", () => {
	const diagnostics = validatePreflightShape({
		action: "start",
		objective: "x",
	});
	const start = diagnostics.find(
		(d) => d.code === "start-control-fields-denied",
	);
	assert.ok(
		start,
		"objective at top-level should produce start-control-fields-denied",
	);
	assert.ok(start.fields?.includes("objective"));
	assert.ok(start.repair?.includes("Move graph body fields under graph"));
});

test("PRE: extensionTools at top-level still gets the dedicated repair message", () => {
	const diagnostics = validatePreflightShape({
		action: "start",
		extensionTools: [],
		graph: {
			objective: "o",
			steps: [{ id: "a", agent: { system: "s" }, task: "t" }],
		},
	});
	const denied = diagnostics.find(
		(d) =>
			d.code === "start-control-fields-denied" &&
			d.fields?.includes("extensionTools"),
	);
	assert.ok(denied, "extensionTools at top-level should be flagged misplaced");
	assert.ok(denied.repair?.includes("Place extensionTools under steps[].agent.extensionTools"));
});

test("PRE: schema rejects legacy fields nested under graph", () => {
	const invalid = {
		action: "start",
		graph: {
			objective: "o",
			steps: [{ id: "a", agent: { system: "s" }, task: "t" }],
			agents: [{ id: "legacy" }],
			synthesis: { task: "legacy" },
			outputContract: "legacy",
			callerSkills: ["legacy"],
		},
	};
	assert.equal(validate.Check(invalid), false);
});

test("PRE: schema fully rejects unknown graph-body fields even when preflight is silent", () => {
	const invalid = {
		objective: "o",
		steps: [{ id: "a", agent: { system: "s" }, task: "t" }],
		outputContract: "anything",
	};
	// This is the schema-level safety net: GraphSchema's
	// additionalProperties:false rejects unknown keys without a preflight legacy repair.
	const wrapped = { action: "start", graph: invalid };
	assert.equal(validate.Check(wrapped), false);
});
