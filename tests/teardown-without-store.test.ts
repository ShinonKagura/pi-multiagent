/** FIX-2 regression: teardownWorktreeForStep accepts optional artifactStore (sweep path). */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prepareWorktreeForStep,
	teardownWorktreeForStep,
} from "../extensions/multiagent/src/mutation-worktree.ts";

function makeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "fix2-"));
	execSync("git init -q -b main", { cwd: repo });
	execSync("git config user.email t@t && git config user.name T", {
		cwd: repo,
	});
	writeFileSync(join(repo, "README.md"), "# i\n");
	execSync("git add . && git commit -q -m i", { cwd: repo });
	return repo;
}

test("FIX-2: teardown without artifactStore — diffStat captured, patchPath undefined, no warnings", () => {
	const repo = makeRepo();
	try {
		const wt = prepareWorktreeForStep({
			invocationCwd: repo,
			stepId: "s",
			runId: "r1",
		});
		writeFileSync(join(wt.worktreePath, "X.md"), "x\n");
		execSync("git add . && git commit -q -m s", { cwd: wt.worktreePath });

		const evidence = teardownWorktreeForStep({ state: wt }); // no artifactStore
		assert.equal(evidence.cleanupWarnings.length, 0);
		assert.ok(
			evidence.diffStat?.includes("X.md"),
			"diffStat should still be captured",
		);
		assert.equal(
			evidence.patchPath,
			undefined,
			"patchPath must be undefined when no store provided",
		);
		// Worktree still gets removed
		assert.throws(() => statSync(wt.worktreePath));
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
