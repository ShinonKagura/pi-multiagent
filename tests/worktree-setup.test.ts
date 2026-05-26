/** G6/G7: propagateNodeModules + symlinkPaths + path traversal denial. */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execSync } from "node:child_process";
import {
	mkdtempSync,
	writeFileSync,
	mkdirSync,
	lstatSync,
	readlinkSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prepareWorktreeForStep,
	teardownWorktreeForStep,
	applyWorktreeSetup,
} from "../extensions/multiagent/src/mutation-worktree.ts";

function makeRepoWithGitignoredExtras(): string {
	const repo = mkdtempSync(join(tmpdir(), "g6-"));
	execSync("git init -q -b main", { cwd: repo });
	execSync("git config user.email t@t && git config user.name T", {
		cwd: repo,
	});
	writeFileSync(
		join(repo, ".gitignore"),
		"node_modules/\n.venv/\n.env.local\n",
	);
	writeFileSync(join(repo, "README.md"), "# i\n");
	execSync("git add . && git commit -q -m i", { cwd: repo });
	// Populate gitignored sources
	mkdirSync(join(repo, "node_modules"), { recursive: true });
	writeFileSync(join(repo, "node_modules", "fake-pkg"), "x");
	mkdirSync(join(repo, ".venv"));
	writeFileSync(join(repo, ".venv", "bin"), "venv-bin");
	writeFileSync(join(repo, ".env.local"), "TOK=secret");
	return repo;
}

test("G6: propagateNodeModules creates symlink in worktree", () => {
	const repo = makeRepoWithGitignoredExtras();
	try {
		const wt = prepareWorktreeForStep({
			invocationCwd: repo,
			stepId: "mut",
			runId: "r1",
			worktreeSetup: { propagateNodeModules: true },
		});
		assert.equal(
			lstatSync(join(wt.worktreePath, "node_modules")).isSymbolicLink(),
			true,
		);
		assert.equal(
			readlinkSync(join(wt.worktreePath, "node_modules")),
			join(repo, "node_modules"),
		);
		teardownWorktreeForStep({ state: wt });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("G7: symlinkPaths creates symlinks for each declared relative path", () => {
	const repo = makeRepoWithGitignoredExtras();
	try {
		const wt = prepareWorktreeForStep({
			invocationCwd: repo,
			stepId: "mut",
			runId: "r2",
			worktreeSetup: { symlinkPaths: [".venv", ".env.local"] },
		});
		assert.equal(
			lstatSync(join(wt.worktreePath, ".venv")).isSymbolicLink(),
			true,
		);
		assert.equal(
			lstatSync(join(wt.worktreePath, ".env.local")).isSymbolicLink(),
			true,
		);
		teardownWorktreeForStep({ state: wt });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("G7: path traversal symlinks (.., /abs) are denied with warning, no symlink created", () => {
	const repo = makeRepoWithGitignoredExtras();
	try {
		const wt = prepareWorktreeForStep({
			invocationCwd: repo,
			stepId: "mut",
			runId: "r3",
		});
		const outcome = applyWorktreeSetup({
			invocationCwd: repo,
			worktreePath: wt.worktreePath,
			setup: { symlinkPaths: ["../escape", "/abs/path"] },
		});
		assert.equal(outcome.appliedSymlinks.length, 0);
		assert.equal(outcome.warnings.length, 2);
		assert.ok(
			outcome.warnings.every(
				(w) => w.includes("denied") || w.includes("relative"),
			),
		);
		teardownWorktreeForStep({ state: wt });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("Backward compat: no worktreeSetup → worktree starts without symlinks", () => {
	const repo = makeRepoWithGitignoredExtras();
	try {
		const wt = prepareWorktreeForStep({
			invocationCwd: repo,
			stepId: "mut",
			runId: "r4",
		});
		assert.throws(() => statSync(join(wt.worktreePath, "node_modules")));
		teardownWorktreeForStep({ state: wt });
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
