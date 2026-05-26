/** F5 A4-A7: real-git fixture, dirty rejection, prepare+teardown, parallel isolation. */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execSync } from "node:child_process";
import {
	mkdtempSync,
	writeFileSync,
	statSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prepareWorktreeForStep,
	teardownWorktreeForStep,
	WorktreeError,
} from "../extensions/multiagent/src/mutation-worktree.ts";
import { createRunArtifactStore } from "../extensions/multiagent/src/background-artifacts.ts";

function makeCleanRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "f5-lc-"));
	execSync("git init -q -b main", { cwd: repo });
	execSync(
		"git config user.email test@example.com && git config user.name Tester",
		{ cwd: repo },
	);
	writeFileSync(join(repo, "README.md"), "# init\n");
	execSync("git add . && git commit -q -m init", { cwd: repo });
	return repo;
}

test("F5 A4: not-a-git-repo cwd fails closed with worktree-not-git-repo", () => {
	const nonRepo = mkdtempSync(join(tmpdir(), "f5-nogit-"));
	try {
		assert.throws(
			() =>
				prepareWorktreeForStep({
					invocationCwd: nonRepo,
					stepId: "x",
					runId: "r1",
				}),
			(err: unknown) =>
				err instanceof WorktreeError && err.code === "worktree-not-git-repo",
		);
	} finally {
		rmSync(nonRepo, { recursive: true, force: true });
	}
});

test("F5 A4: dirty working tree fails closed with worktree-tree-dirty", () => {
	const repo = makeCleanRepo();
	try {
		writeFileSync(join(repo, "README.md"), "dirty\n");
		assert.throws(
			() =>
				prepareWorktreeForStep({
					invocationCwd: repo,
					stepId: "x",
					runId: "r1",
				}),
			(err: unknown) =>
				err instanceof WorktreeError && err.code === "worktree-tree-dirty",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("F5 A5+A6: prepare → mutate → teardown captures diff+patch and removes worktree+branch", () => {
	const repo = makeCleanRepo();
	const wt = prepareWorktreeForStep({
		invocationCwd: repo,
		stepId: "mut",
		runId: "r1",
	});
	try {
		assert.equal(statSync(wt.worktreePath).isDirectory(), true);
		writeFileSync(join(wt.worktreePath, "NEW.md"), "added in worktree\n");
		execSync("git add . && git commit -q -m step", { cwd: wt.worktreePath });

		const store = createRunArtifactStore();
		try {
			const evidence = teardownWorktreeForStep({
				state: wt,
				artifactStore: store,
			});
			assert.equal(evidence.cleanupWarnings.length, 0);
			assert.ok(evidence.diffStat?.includes("NEW.md"));
			assert.ok(
				evidence.patchPath,
				"patch artifact path should be set when artifactStore is provided",
			);
			assert.ok(
				readFileSync(evidence.patchPath!, "utf8").startsWith("diff --git"),
			);

			// Worktree dir gone
			assert.throws(() => statSync(wt.worktreePath));
			// Branch gone in repo
			const branches = execSync("git branch -a", {
				cwd: repo,
				encoding: "utf8",
			});
			assert.equal(branches.includes("pi-multiagent/r1/mut"), false);
			// Invocation repo HEAD unchanged
			const head = execSync("git rev-parse HEAD", {
				cwd: repo,
				encoding: "utf8",
			}).trim();
			assert.equal(head.length, 40);
		} finally {
			rmSync(store.runDir, { recursive: true, force: true });
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("F5 A7: two parallel worktree-isolated steps operate on independent worktrees", () => {
	const repo = makeCleanRepo();
	try {
		const wt1 = prepareWorktreeForStep({
			invocationCwd: repo,
			stepId: "stepa",
			runId: "r1",
		});
		const wt2 = prepareWorktreeForStep({
			invocationCwd: repo,
			stepId: "stepb",
			runId: "r1",
		});
		try {
			assert.notEqual(
				wt1.worktreePath,
				wt2.worktreePath,
				"worktree paths must be distinct",
			);
			assert.notEqual(
				wt1.branchName,
				wt2.branchName,
				"branch names must be distinct",
			);

			writeFileSync(join(wt1.worktreePath, "A.md"), "a\n");
			execSync("git add . && git commit -q -m a", { cwd: wt1.worktreePath });
			writeFileSync(join(wt2.worktreePath, "B.md"), "b\n");
			execSync("git add . && git commit -q -m b", { cwd: wt2.worktreePath });

			// Each worktree sees only its own change
			assert.equal(statSync(join(wt1.worktreePath, "A.md")).isFile(), true);
			assert.throws(() => statSync(join(wt1.worktreePath, "B.md")));
			assert.equal(statSync(join(wt2.worktreePath, "B.md")).isFile(), true);
			assert.throws(() => statSync(join(wt2.worktreePath, "A.md")));
		} finally {
			teardownWorktreeForStep({ state: wt1 });
			teardownWorktreeForStep({ state: wt2 });
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("F5 worktree-branch-exists fails closed with recovery hint when branch already exists", () => {
	const repo = makeCleanRepo();
	try {
		execSync("git branch pi-multiagent/r1/dup", { cwd: repo });
		assert.throws(
			() =>
				prepareWorktreeForStep({
					invocationCwd: repo,
					stepId: "dup",
					runId: "r1",
				}),
			(err: unknown) =>
				err instanceof WorktreeError &&
				err.code === "worktree-branch-exists" &&
				(err as WorktreeError).message.includes("git branch -D"),
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
