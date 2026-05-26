/** F5 A1-A3: schema + planning rejections for worktree isolation, no spawn. */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Value } from "typebox/value";
import { resolveDetachedGraph } from "../extensions/multiagent/src/planning.ts";
import { AgentTeamSchema } from "../extensions/multiagent/src/schemas.ts";

const baseCtx = {
	parentTools: { apiAvailable: true, errorMessage: undefined, tools: [] },
	parentSkills: {
		apiAvailable: true,
		readActive: true,
		errorMessage: undefined,
		skills: [],
	},
	cwd: process.cwd(),
	invocationCwd: process.cwd(),
};

test("F5 A1: graphs without isolation behave identically to pre-F5", () => {
	const result = resolveDetachedGraph(
		{
			objective: "no isolation",
			authority: { allowFilesystemRead: true },
			steps: [
				{
					id: "s",
					agent: { system: "scout", tools: ["read", "grep", "find", "ls"] },
					task: "inspect",
				},
			],
		},
		[],
		[],
		baseCtx,
		undefined,
	);
	assert.equal(
		result.diagnostics.filter((d) => d.severity === "error").length,
		0,
	);
	assert.equal(result.steps[0]?.isolation, undefined);
});

test("F5 A2: worktree-authority-required when isolation:worktree without graph authority", () => {
	const result = resolveDetachedGraph(
		{
			objective: "auth denied",
			authority: {
				allowFilesystemRead: true,
				allowMutationTools: true,
				allowMutationWorktree: false,
			},
			steps: [
				{
					id: "m",
					agent: {
						system: "mut",
						tools: ["read", "grep", "find", "ls", "edit", "write"],
					},
					task: "t",
					mutationScope: "edit allowed under src/",
					isolation: "worktree",
				},
			],
		},
		[],
		[],
		baseCtx,
		undefined,
	);
	assert.ok(
		result.diagnostics.some((d) => d.code === "worktree-authority-required"),
	);
});

test("F5 A3: worktree-non-mutation-denied on read-only step", () => {
	const result = resolveDetachedGraph(
		{
			objective: "non-mutation",
			authority: { allowFilesystemRead: true, allowMutationWorktree: true },
			steps: [
				{
					id: "r",
					agent: { system: "ro", tools: ["read", "grep", "find", "ls"] },
					task: "t",
					isolation: "worktree",
				},
			],
		},
		[],
		[],
		baseCtx,
		undefined,
	);
	assert.ok(
		result.diagnostics.some((d) => d.code === "worktree-non-mutation-denied"),
	);
});

test("F5 schema: invalid isolation value is rejected by schema", () => {
	const invalid = {
		action: "start",
		graph: {
			objective: "x",
			authority: {
				allowFilesystemRead: true,
				allowMutationTools: true,
				allowMutationWorktree: true,
			},
			steps: [
				{
					id: "a",
					agent: {
						system: "s",
						tools: ["read", "grep", "find", "ls", "edit", "write"],
					},
					task: "t",
					mutationScope: "edit allowed under src/",
					isolation: "sandbox",
				},
			],
		},
	};
	assert.equal(Value.Check(AgentTeamSchema, invalid), false);
});

test("F5 valid: mutation-capable step with authority resolves with isolation carried through", () => {
	const result = resolveDetachedGraph(
		{
			objective: "valid",
			authority: {
				allowFilesystemRead: true,
				allowMutationTools: true,
				allowMutationWorktree: true,
			},
			steps: [
				{
					id: "m",
					agent: {
						system: "mut",
						tools: ["read", "grep", "find", "ls", "edit", "write"],
					},
					task: "t",
					mutationScope: "edit allowed under src/",
					isolation: "worktree",
				},
			],
		},
		[],
		[],
		baseCtx,
		undefined,
	);
	assert.equal(
		result.diagnostics.filter((d) => d.severity === "error").length,
		0,
	);
	assert.equal(result.steps[0]?.isolation, "worktree");
});
