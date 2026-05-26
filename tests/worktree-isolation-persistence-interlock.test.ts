/** FIX-1 HIGH regression: persistence-unavailable + worktree isolation = fail closed at construction. */

import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { resolveDetachedGraph } from "../extensions/multiagent/src/planning.ts";
import { DetachedRun } from "../extensions/multiagent/src/detached-run.ts";
import { unavailableTools } from "../extensions/multiagent/src/runtime-options.ts";

let originalStateDir: string | undefined;

before(() => {
	originalStateDir = process.env.PI_MULTIAGENT_STATE_DIR;
	// Point persistence at an unwritable path to force createPersistentRun to return undefined
	process.env.PI_MULTIAGENT_STATE_DIR = `/proc/1/cannot-write-${Date.now()}`;
});

after(() => {
	if (originalStateDir === undefined)
		delete process.env.PI_MULTIAGENT_STATE_DIR;
	else process.env.PI_MULTIAGENT_STATE_DIR = originalStateDir;
});

const baseCtx = {
	parentTools: unavailableTools(),
	parentSkills: {
		apiAvailable: true,
		readActive: true,
		errorMessage: undefined,
		skills: [],
	},
	cwd: "/tmp",
	invocationCwd: "/tmp",
};

const runtimeOptsBase = {
	cwd: "/tmp",
	packageAgentsDir: "/tmp/agents",
	materializationDiagnostics: [],
	catalogPreparationDiagnostics: [],
	catalogLibrary: {
		sources: ["package" as const],
		query: undefined,
		projectAgents: "deny" as const,
	},
	sessionId: "test-session",
	defaults: { model: undefined, thinking: undefined },
	parentTools: unavailableTools(),
	parentSkills: {
		apiAvailable: true,
		readActive: true,
		errorMessage: undefined,
		skills: [],
	},
	signal: undefined,
	onUpdate: undefined,
};

test("FIX-1: worktree-isolated step + unavailable persistence → run is failed at construction with persistent-run-unavailable-with-worktree", () => {
	const resolved = resolveDetachedGraph(
		{
			objective: "test fail-closed",
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
					task: "edit",
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
	const run = new DetachedRun("r1", resolved, runtimeOptsBase, {
		sources: ["package"],
		query: undefined,
		projectAgents: "deny",
	});
	const snap = run.snapshot();
	assert.equal(snap.status, "failed");
	assert.equal(snap.terminal, true);
	const diags = run.details("run_status").diagnostics;
	assert.ok(
		diags.some((d) => d.code === "persistent-run-unavailable-with-worktree"),
		"FIX-1 diagnostic must be present",
	);
});

test("FIX-1: no worktree step + unavailable persistence → run still proceeds with graceful warning", () => {
	const resolved = resolveDetachedGraph(
		{
			objective: "test graceful degrade",
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
	const run = new DetachedRun("r2", resolved, runtimeOptsBase, {
		sources: ["package"],
		query: undefined,
		projectAgents: "deny",
	});
	const snap = run.snapshot();
	// Status should still be "running" (no fail-closed for no-worktree path)
	assert.notEqual(snap.status, "failed");
	const diags = run.details("run_status").diagnostics;
	assert.ok(
		diags.some((d) => d.code === "persistent-run-unavailable"),
		"graceful warning diagnostic must be present",
	);
	assert.equal(
		diags.some((d) => d.code === "persistent-run-unavailable-with-worktree"),
		false,
		"fail-closed diagnostic must NOT fire when no worktree step is present",
	);
});

test("FIX-1+G4: pre-start fail emits pi-multiagent:run-failed-pre-start lifecycle event", () => {
	const events: { name: string; payload: unknown }[] = [];
	const resolved = resolveDetachedGraph(
		{
			objective: "test event",
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
					task: "edit",
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
	const run = new DetachedRun(
		"r3",
		resolved,
		{
			...runtimeOptsBase,
			emitLifecycleEvent: (name, payload) => events.push({ name, payload }),
		},
		{ sources: ["package"], query: undefined, projectAgents: "deny" },
	);
	run.start();
	const failedEvent = events.find(
		(e) => e.name === "pi-multiagent:run-failed-pre-start",
	);
	assert.ok(failedEvent, "fail-pre-start lifecycle event must be emitted");
	assert.equal((failedEvent.payload as { runId: string }).runId, "r3");
});
