/** NEU-A B1a: persistent-run-state.ts unit coverage. */

import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	writeFileSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let stateRoot: string;
let m: typeof import("../extensions/multiagent/src/persistent-run-state.ts");

before(async () => {
	stateRoot = mkdtempSync(join(tmpdir(), "neua-test-"));
	process.env.PI_MULTIAGENT_STATE_DIR = stateRoot;
	m = await import("../extensions/multiagent/src/persistent-run-state.ts");
});

after(() => {
	rmSync(stateRoot, { recursive: true, force: true });
	delete process.env.PI_MULTIAGENT_STATE_DIR;
});

test("B1a createPersistentRun returns handle and writes manifest/status/worktrees/lock", () => {
	const handle = m.createPersistentRun({
		runId: "r1",
		manifest: {
			runId: "r1",
			createdAt: new Date().toISOString(),
			invocationCwd: "/tmp/x",
			objective: "test",
			ownerPid: process.pid,
			ownerSessionId: "sess",
			piVersion: "0.74.0",
			terminalRetentionSeconds: 86400,
		},
	});
	assert.ok(handle);
	assert.equal(statSync(handle!.runDir).isDirectory(), true);
	assert.equal(
		readFileSync(handle!.lockPath, "utf8").trim(),
		String(process.pid),
	);
	assert.equal(m.readManifest(handle!.runDir)?.runId, "r1");
	assert.equal(m.readPersistedStatus(handle!.runDir)?.status, "running");
	assert.equal(m.readPersistedWorktrees(handle!.runDir).length, 0);
});

test("B1a recordWorktreeForStep + markWorktreeCleanedUp", () => {
	const handle = m.createPersistentRun({
		runId: "r2",
		manifest: {
			runId: "r2",
			createdAt: new Date().toISOString(),
			invocationCwd: "/tmp/x",
			objective: "wt",
			ownerPid: process.pid,
			ownerSessionId: undefined,
			piVersion: undefined,
			terminalRetentionSeconds: 86400,
		},
	})!;
	m.recordWorktreeForStep(handle, {
		stepId: "s1",
		worktreePath: "/tmp/wt1",
		branchName: "pi-multiagent/r2/s1",
		baseCommit: "a".repeat(40),
		repoRoot: "/tmp/repo",
	});
	m.recordWorktreeForStep(handle, {
		stepId: "s2",
		worktreePath: "/tmp/wt2",
		branchName: "pi-multiagent/r2/s2",
		baseCommit: "b".repeat(40),
		repoRoot: "/tmp/repo",
	});
	assert.equal(m.readPersistedWorktrees(handle.runDir).length, 2);
	m.markWorktreeCleanedUp(handle, "s1");
	const wts = m.readPersistedWorktrees(handle.runDir);
	assert.equal(wts.find((w) => w.stepId === "s1")?.cleanedUp, true);
	assert.equal(wts.find((w) => w.stepId === "s2")?.cleanedUp, false);
});

test("B1a sweepRunsRoot detects orphan and calls prune callback for pending worktrees only", () => {
	const handle = m.createPersistentRun({
		runId: "r3",
		manifest: {
			runId: "r3",
			createdAt: new Date().toISOString(),
			invocationCwd: "/tmp/x",
			objective: "sweep",
			ownerPid: process.pid,
			ownerSessionId: undefined,
			piVersion: undefined,
			terminalRetentionSeconds: 86400,
		},
	})!;
	m.recordWorktreeForStep(handle, {
		stepId: "leak",
		worktreePath: "/tmp/leak",
		branchName: "pi-multiagent/r3/leak",
		baseCommit: "c".repeat(40),
		repoRoot: "/tmp/repo",
	});
	writeFileSync(handle.lockPath, "999999999\n");

	const pruneArgs: string[][] = [];
	const sweep = m.sweepRunsRoot({
		pruneWorktrees: (records) => {
			pruneArgs.push(records.map((r) => r.stepId));
			return { cleaned: records.map((r) => r.stepId), warnings: [] };
		},
	});
	assert.ok(sweep.orphanedRuns.some((r) => r.runId === "r3"));
	assert.ok(
		pruneArgs.some((args) => args.includes("leak")),
		"prune callback should have been called with leak step",
	);
	assert.ok(sweep.prunedWorktrees >= 1);
});

test("B1a sweep skips live runs (lock held by live PID)", () => {
	const handle = m.createPersistentRun({
		runId: "r4",
		manifest: {
			runId: "r4",
			createdAt: new Date().toISOString(),
			invocationCwd: "/tmp/x",
			objective: "live",
			ownerPid: process.pid,
			ownerSessionId: undefined,
			piVersion: undefined,
			terminalRetentionSeconds: 86400,
		},
	})!;
	const sweep = m.sweepRunsRoot({
		pruneWorktrees: () => ({ cleaned: [], warnings: [] }),
	});
	assert.equal(
		sweep.orphanedRuns.some((r) => r.runId === "r4"),
		false,
		"live run with our PID should not be classified as orphan",
	);
});
