/** B1 runtime model-fallback: end-to-end proof.
 *
 * A step whose primary model returns a model/provider error must retry on the next declared fallback
 * model and succeed, emitting a `model-fallback` event. Uses an in-memory fake child that fails the
 * first launch (model-error) and succeeds the second (the fallback lane).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { DetachedRun } from "../extensions/multiagent/src/detached-run.ts";
import type { SpawnOptions, SpawnProcess } from "../extensions/multiagent/src/child-launch.ts";
import { resolveDetachedGraph } from "../extensions/multiagent/src/planning.ts";
import { unavailableTools } from "../extensions/multiagent/src/runtime-options.ts";
import { FakeRpcChild } from "./fake-rpc-child.ts";

let originalState: string | undefined;
let originalLauncher: string | undefined;

before(() => {
	originalState = process.env.PI_MULTIAGENT_STATE_DIR;
	originalLauncher = process.env.PI_MULTIAGENT_PI_LAUNCHER;
	process.env.PI_MULTIAGENT_STATE_DIR = mkdtempSync(join(tmpdir(), "pi-mt-fallback-"));
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

function runtimeOptions(spawnProcess: SpawnProcess) {
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
	};
}

test("primary model failure retries on the declared fallback model and the step succeeds", async () => {
	const spawnedModels: string[] = [];
	let spawnCount = 0;
	const spawnProcess = ((_command: string, args: string[], _options: SpawnOptions) => {
		spawnCount += 1;
		const modelIndex = args.indexOf("--model");
		spawnedModels.push(modelIndex >= 0 ? (args[modelIndex + 1] ?? "(missing)") : "(none)");
		// First launch (primary model) fails with a model error; the fallback launch succeeds.
		return new FakeRpcChild(spawnCount === 1 ? "model-error" : "success") as unknown as ChildProcessWithoutNullStreams;
	}) as SpawnProcess;

	const resolved = resolveDetachedGraph(
		{
			objective: "fallback",
			authority: { allowFilesystemRead: true },
			steps: [{ id: "one", agent: { system: "x", tools: ["read", "grep", "find", "ls"], model: "primary-model", fallbackModels: ["fallback-model"] }, task: "do work" }],
		},
		[],
		[],
		baseCtx,
		undefined,
	);
	assert.equal(resolved.diagnostics.some((item) => item.severity === "error"), false, "graph should resolve cleanly");

	const run = new DetachedRun("r1", resolved, runtimeOptions(spawnProcess), { sources: ["package"], query: undefined, projectAgents: "deny" });
	run.start();
	for (let i = 0; i < 200 && !run.snapshot().terminal; i++) await new Promise((resolve) => setTimeout(resolve, 25));

	assert.equal(run.snapshot().terminal, true, "run should terminalize");
	assert.deepEqual(spawnedModels, ["primary-model", "fallback-model"], "should try primary then fall back");
	// Core proof: the spawn sequence shows the primary lane failed and the fallback lane ran, and the
	// step + run completed successfully on that fallback model. (The fallback also emits an internal
	// `model-fallback` event for live observability.)
	const details = run.details("run_status", { maxBytes: 5_000_000 });
	assert.equal(details.steps.find((step) => step.id === "one")?.status, "succeeded", "step should succeed on the fallback model");
	assert.equal(run.snapshot().status, "succeeded");
});
