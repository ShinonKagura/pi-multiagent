/** B2 lifecycle events: a run emits started/completed (+ a status-specific terminal event) under both
 * the legacy `pi-multiagent:` prefix and the `hb-orchestra:` brand, so cross-extension consumers can
 * subscribe to either. */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { DetachedRun } from "../extensions/multiagent/src/detached-run.ts";
import type { SpawnProcess } from "../extensions/multiagent/src/child-launch.ts";
import { resolveDetachedGraph } from "../extensions/multiagent/src/planning.ts";
import { unavailableTools } from "../extensions/multiagent/src/runtime-options.ts";
import { fakeSpawn } from "./fake-rpc-child.ts";

let originalState: string | undefined;
let originalLauncher: string | undefined;

before(() => {
	originalState = process.env.PI_MULTIAGENT_STATE_DIR;
	originalLauncher = process.env.PI_MULTIAGENT_PI_LAUNCHER;
	process.env.PI_MULTIAGENT_STATE_DIR = mkdtempSync(join(tmpdir(), "pi-mt-lifecycle-"));
	process.env.PI_MULTIAGENT_PI_LAUNCHER = process.execPath;
});

after(() => {
	if (originalState === undefined) delete process.env.PI_MULTIAGENT_STATE_DIR;
	else process.env.PI_MULTIAGENT_STATE_DIR = originalState;
	if (originalLauncher === undefined) delete process.env.PI_MULTIAGENT_PI_LAUNCHER;
	else process.env.PI_MULTIAGENT_PI_LAUNCHER = originalLauncher;
});

const parentSkills = { apiAvailable: true, readActive: true, errorMessage: undefined, skills: [] };
const baseCtx = { parentTools: unavailableTools(), parentSkills, cwd: "/tmp", invocationCwd: "/tmp" };

function runtimeOptions(spawnProcess: SpawnProcess, emitLifecycleEvent: (name: string, payload: Record<string, unknown>) => void) {
	return {
		cwd: "/tmp",
		packageAgentsDir: "/tmp/agents",
		materializationDiagnostics: [],
		catalogPreparationDiagnostics: [],
		catalogLibrary: { sources: ["package" as const], query: undefined, projectAgents: "deny" as const },
		sessionId: "test-session",
		defaults: { model: undefined, thinking: undefined },
		parentTools: unavailableTools(),
		parentSkills,
		signal: undefined,
		onUpdate: undefined,
		spawnProcess,
		emitLifecycleEvent,
	};
}

test("a successful run emits dual-branded lifecycle events incl. a status-specific terminal event", async () => {
	const events: { name: string; payload: Record<string, unknown> }[] = [];
	const resolved = resolveDetachedGraph(
		{ objective: "lifecycle", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { system: "x", tools: ["read", "grep", "find", "ls"] }, task: "do work" }] },
		[],
		[],
		baseCtx,
		undefined,
	);
	const run = new DetachedRun("r1", resolved, runtimeOptions(fakeSpawn("success"), (name, payload) => events.push({ name, payload })), { sources: ["package"], query: undefined, projectAgents: "deny" });
	run.start();
	for (let i = 0; i < 200 && !run.snapshot().terminal; i++) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(run.snapshot().status, "succeeded");

	const names = new Set(events.map((event) => event.name));
	// started + completed mirrored under both prefixes
	for (const name of ["pi-multiagent:run-started", "hb-orchestra:run-started", "pi-multiagent:run-completed", "hb-orchestra:run-completed"]) {
		assert.ok(names.has(name), `expected lifecycle event ${name}`);
	}
	// status-specific terminal event for a successful run
	assert.ok(names.has("hb-orchestra:run-succeeded"), "expected hb-orchestra:run-succeeded");
	assert.ok(names.has("pi-multiagent:run-succeeded"), "expected pi-multiagent:run-succeeded");
	// the run-completed payload carries the terminal status
	const completed = events.find((event) => event.name === "hb-orchestra:run-completed");
	assert.equal(completed?.payload.status, "succeeded");
	assert.equal(completed?.payload.runId, "r1");
});
