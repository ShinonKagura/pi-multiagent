/** FIX-4 regression: pruneOrphanWorktreeBranches removes pi-multiagent/* with no worktree. */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prepareWorktreeForStep,
	pruneOrphanWorktreeBranches,
} from "../extensions/multiagent/src/mutation-worktree.ts";

test("FIX-4: orphan pi-multiagent/* branch (worktree removed, branch survived) is pruned", () => {
	const repo = mkdtempSync(join(tmpdir(), "fix4-"));
	try {
		execSync("git init -q -b main", { cwd: repo });
		execSync("git config user.email t@t && git config user.name T", {
			cwd: repo,
		});
		writeFileSync(join(repo, "README.md"), "# i\n");
		execSync("git add . && git commit -q -m i", { cwd: repo });

		const wt = prepareWorktreeForStep({
			invocationCwd: repo,
			stepId: "orph",
			runId: "r9",
		});
		// Simulate partial teardown crash: remove worktree but leave the branch
		execSync(`git worktree remove --force ${wt.worktreePath}`, { cwd: repo });
		assert.ok(
			execSync("git branch -a", { cwd: repo, encoding: "utf8" }).includes(
				"pi-multiagent/r9/orph",
			),
			"branch should still exist after partial teardown",
		);

		const result = pruneOrphanWorktreeBranches(repo);
		assert.ok(result.removedBranches.includes("pi-multiagent/r9/orph"));
		assert.equal(result.warnings.length, 0);
		assert.equal(
			execSync("git branch -a", { cwd: repo, encoding: "utf8" }).includes(
				"pi-multiagent/r9/orph",
			),
			false,
			"branch must be gone after prune",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("FIX-4: pruneOrphanWorktreeBranches preserves non-pi-multiagent branches", () => {
	const repo = mkdtempSync(join(tmpdir(), "fix4b-"));
	try {
		execSync("git init -q -b main", { cwd: repo });
		execSync("git config user.email t@t && git config user.name T", {
			cwd: repo,
		});
		writeFileSync(join(repo, "README.md"), "# i\n");
		execSync("git add . && git commit -q -m i", { cwd: repo });
		execSync("git branch feature-x", { cwd: repo });

		const result = pruneOrphanWorktreeBranches(repo);
		assert.equal(
			result.removedBranches.length,
			0,
			"non-pi-multiagent branches must not be touched",
		);
		assert.ok(
			execSync("git branch -a", { cwd: repo, encoding: "utf8" }).includes(
				"feature-x",
			),
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
