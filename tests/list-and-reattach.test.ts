/** NEU-A B1b: list + reattach tool actions, owner classification. */

import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTeam } from "../extensions/multiagent/src/delegation.ts";
import {
	createPersistentRun,
	recordWorktreeForStep,
	updatePersistentRunStatus,
} from "../extensions/multiagent/src/persistent-run-state.ts";
import { unavailableTools } from "../extensions/multiagent/src/runtime-options.ts";

let stateRoot: string;

before(() => {
	stateRoot = mkdtempSync(join(tmpdir(), "b1b-"));
	process.env.PI_MULTIAGENT_STATE_DIR = stateRoot;
});

after(() => {
	rmSync(stateRoot, { recursive: true, force: true });
	delete process.env.PI_MULTIAGENT_STATE_DIR;
});

const baseOpts = () => ({
	cwd: process.cwd(),
	packageAgentsDir: process.cwd() + "/agents",
	materializationDiagnostics: [],
	catalogPreparationDiagnostics: [],
	catalogLibrary: {
		sources: ["package" as const],
		query: undefined,
		projectAgents: "deny" as const,
	},
	sessionId: "this-session",
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
});

test("B1b list: empty initially", async () => {
	const result = await runAgentTeam({ action: "list" }, baseOpts());
	assert.equal(result.details.ok, true);
	assert.equal(result.details.listedRuns?.length, 0);
});

test("B1b list: sees persisted run and classifies as orphan (dead PID)", async () => {
	const handle = createPersistentRun({
		runId: "r42",
		manifest: {
			runId: "r42",
			createdAt: new Date().toISOString(),
			invocationCwd: "/tmp/x",
			objective: "demo",
			ownerPid: 999,
			ownerSessionId: "prior-session",
			piVersion: "0.74.0",
			terminalRetentionSeconds: 86400,
		},
	})!;
	writeFileSync(handle.lockPath, "999999999\n");
	recordWorktreeForStep(handle, {
		stepId: "s1",
		worktreePath: "/tmp/wt-x",
		branchName: "pi-multiagent/r42/s1",
		baseCommit: "b".repeat(40),
		repoRoot: "/tmp/x",
	});
	updatePersistentRunStatus(handle, "running", false);

	const result = await runAgentTeam({ action: "list" }, baseOpts());
	const r42 = result.details.listedRuns?.find((r) => r.runId === "r42");
	assert.ok(r42);
	assert.equal(r42!.owner, "orphan");
	assert.equal(r42!.worktreesPendingCleanup, 1);
});

test("B1b reattach: returns read-only snapshot for orphan", async () => {
	const result = await runAgentTeam(
		{ action: "reattach", runId: "r42" },
		baseOpts(),
	);
	assert.equal(result.details.ok, true);
	assert.ok(result.details.reattach);
	assert.equal(result.details.reattach!.readOnly, true);
	assert.equal(result.details.reattach!.owner, "orphan");
	assert.equal(result.details.reattach!.controlDenied, true);
	assert.ok(result.details.reattach!.controlDeniedReason);
	assert.equal(result.details.reattach!.worktrees.length, 1);
});

test("B1b reattach: missing runId is rejected with run-id-required", async () => {
	const result = await runAgentTeam({ action: "reattach" }, baseOpts());
	assert.equal(result.details.ok, false);
	assert.equal(result.details.error?.code, "run-id-required");
});

test("B1b reattach: unknown runId returns reattach-run-not-found", async () => {
	const result = await runAgentTeam(
		{ action: "reattach", runId: "r999" },
		baseOpts(),
	);
	assert.equal(result.details.ok, false);
	assert.equal(result.details.error?.code, "reattach-run-not-found");
});
