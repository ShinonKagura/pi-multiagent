/** Per-step git worktree isolation for mutation-capable detached steps (F5). */

import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { writeRunArtifact, type RunArtifactStore } from "./background-artifacts.ts";
import type { MutationWorktreeState, WorktreeSetupSpec, WorktreeTeardownEvidence } from "./types.ts";

/**
 * Strict guarantee: either returns a valid MutationWorktreeState whose worktreePath
 * is a real, owned, isolated git worktree, or throws `WorktreeError`. There is no
 * silent fallback to the invocation cwd; callers that catch the error must fail the
 * step instead of running unisolated.
 */
export class WorktreeError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "WorktreeError";
		this.code = code;
	}
}

const GIT_TIMEOUT_MS = 30000;

export interface PrepareWorktreeInput {
	invocationCwd: string;
	stepId: string;
	runId: string;
	worktreeSetup?: WorktreeSetupSpec;
}

export interface WorktreeSetupOutcome {
	appliedSymlinks: string[];
	warnings: string[];
}

export function prepareWorktreeForStep(input: PrepareWorktreeInput): MutationWorktreeState {
	if (!isPublicId(input.stepId)) throw new WorktreeError("worktree-step-id-invalid", `Step id ${input.stepId} is not a valid public id.`);
	if (!isRunId(input.runId)) throw new WorktreeError("worktree-run-id-invalid", `Run id ${input.runId} is not a valid run id.`);
	const repoRoot = findGitRoot(input.invocationCwd);
	assertCleanWorkingTree(repoRoot);
	const baseCommit = resolveHeadCommit(repoRoot);
	const branchName = `pi-multiagent/${input.runId}/${input.stepId}`;
	assertBranchDoesNotExist(repoRoot, branchName);
	const worktreePath = createWorktreeTmpDir();
	try {
		gitExec(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
	} catch (error) {
		// Cleanup tmp dir we created but could not turn into a worktree.
		bestEffortRemoveDir(worktreePath);
		throw new WorktreeError("worktree-add-failed", `git worktree add failed: ${errorMessage(error)}`);
	}
	const resolvedPath = safeRealpath(worktreePath) ?? worktreePath;
	const state: MutationWorktreeState = { stepId: input.stepId, worktreePath: resolvedPath, branchName, baseCommit, repoRoot };
	if (input.worktreeSetup) {
		// Apply declarative setup (G6/G7). Failures are warnings, not fatal errors: a missing
		// node_modules or symlink source means the step starts without that dependency, and
		// the task body will see the failure organically (e.g. `cannot find module ...`).
		applyWorktreeSetup({ invocationCwd: input.invocationCwd, worktreePath: resolvedPath, setup: input.worktreeSetup });
	}
	return state;
}

/** G6/G7: best-effort declarative setup. Symlinks `node_modules` and configured paths from invocation cwd into the worktree. Never throws — returns warnings list for receipt rendering. */
export function applyWorktreeSetup(input: { invocationCwd: string; worktreePath: string; setup: WorktreeSetupSpec }): WorktreeSetupOutcome {
	const outcome: WorktreeSetupOutcome = { appliedSymlinks: [], warnings: [] };
	const paths: string[] = [];
	if (input.setup.propagateNodeModules) paths.push("node_modules");
	for (const path of input.setup.symlinkPaths ?? []) {
		if (isAbsolute(path) || path.split(/[\\/]/).some((segment) => segment === "..")) {
			outcome.warnings.push(`symlinkPaths entry '${path}' is denied: must be a relative path with no '..' segments`);
			continue;
		}
		paths.push(path);
	}
	for (const rel of paths) {
		const source = join(input.invocationCwd, rel);
		const target = join(input.worktreePath, rel);
		try {
			if (!safeExists(source)) {
				outcome.warnings.push(`${rel}: source does not exist at ${source}`);
				continue;
			}
			// Ensure parent dir exists in worktree for nested symlink paths.
			const parentDir = dirname(target);
			if (parentDir !== input.worktreePath) {
				try { ensureDir(parentDir); } catch (error) { outcome.warnings.push(`${rel}: could not ensure parent dir: ${errorMessage(error)}`); continue; }
			}
			if (safeExists(target)) {
				outcome.warnings.push(`${rel}: target already exists in worktree (git worktree add usually populates a fresh copy); refusing to overwrite`);
				continue;
			}
			symlinkSync(source, target);
			outcome.appliedSymlinks.push(rel);
		} catch (error) {
			outcome.warnings.push(`${rel}: symlink failed: ${errorMessage(error)}`);
		}
	}
	return outcome;
}

function safeExists(path: string): boolean {
	try { lstatSync(path); return true; } catch { return false; }
}

function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

export interface TeardownWorktreeInput {
	state: MutationWorktreeState;
	/**
	 * Optional artifact store. When provided, the captured patch is persisted as a step
	 * artifact and `patchPath` is set on the returned evidence. When omitted, the patch
	 * text is discarded (still captured but not written anywhere) — use this from the
	 * extension startup sweep, where the original run's artifact store is no longer
	 * reachable and patch persistence is not desired for orphan cleanup.
	 */
	artifactStore?: RunArtifactStore;
}

/**
 * Best-effort teardown. Always tries to capture diff stat and patch before removing
 * the worktree, even if the step failed or was canceled. Removal failures are
 * recorded as warnings; they do not throw.
 */
export function teardownWorktreeForStep(input: TeardownWorktreeInput): WorktreeTeardownEvidence {
	const warnings: string[] = [];
	const { state, artifactStore } = input;
	let diffStat: string | undefined;
	let patchPath: string | undefined;
	try {
		diffStat = gitExec(state.repoRoot, ["-C", state.worktreePath, "diff", "--stat", `${state.baseCommit}..HEAD`]).trim() || undefined;
	} catch (error) {
		warnings.push(`diff-stat capture failed: ${errorMessage(error)}`);
	}
	try {
		const patch = gitExec(state.repoRoot, ["-C", state.worktreePath, "diff", `${state.baseCommit}..HEAD`]);
		if (patch.length > 0 && artifactStore) {
			const record = writeRunArtifact(artifactStore, `${state.stepId}-worktree.patch`, `step-worktree-patch:${state.stepId}`, patch);
			patchPath = record.path;
		}
	} catch (error) {
		warnings.push(`patch capture failed: ${errorMessage(error)}`);
	}
	try {
		gitExec(state.repoRoot, ["worktree", "remove", "--force", state.worktreePath]);
	} catch (error) {
		warnings.push(`git worktree remove failed: ${errorMessage(error)}; attempting filesystem cleanup`);
		bestEffortRemoveDir(state.worktreePath);
	}
	try {
		gitExec(state.repoRoot, ["branch", "-D", state.branchName]);
	} catch (error) {
		warnings.push(`git branch -D failed: ${errorMessage(error)}`);
	}
	return { diffStat, patchPath, branchName: state.branchName, baseCommit: state.baseCommit, cleanupWarnings: warnings };
}

/** Best-effort cleanup hook for extension startup or post-crash sweep (NEU-A interlock). */
export function pruneStaleWorktrees(repoRoot: string): { pruned: boolean; warnings: string[] } {
	const warnings: string[] = [];
	try {
		gitExec(repoRoot, ["worktree", "prune"]);
		return { pruned: true, warnings };
	} catch (error) {
		warnings.push(`git worktree prune failed: ${errorMessage(error)}`);
		return { pruned: false, warnings };
	}
}

// ---------- internals ----------

function findGitRoot(startDir: string): string {
	let current = safeRealpath(startDir);
	if (!current) throw new WorktreeError("worktree-cwd-invalid", `Could not resolve invocation cwd: ${startDir}`);
	while (true) {
		const dotGit = join(current, ".git");
		try {
			const stat = lstatSync(dotGit);
			if (stat.isDirectory() || stat.isFile()) return current;
		} catch {
			// keep walking
		}
		const parent = dirname(current);
		if (parent === current) {
			throw new WorktreeError("worktree-not-git-repo", `No git repository found at or above ${startDir}; worktree isolation requires a git repo.`);
		}
		current = parent;
	}
}

function assertCleanWorkingTree(repoRoot: string): void {
	let status: string;
	try {
		status = gitExec(repoRoot, ["status", "--porcelain"]);
	} catch (error) {
		throw new WorktreeError("worktree-status-failed", `git status failed in ${repoRoot}: ${errorMessage(error)}`);
	}
	if (status.trim().length > 0) {
		throw new WorktreeError("worktree-tree-dirty", `Worktree isolation requires a clean working tree at ${repoRoot}; commit, stash, or discard changes first.`);
	}
}

function resolveHeadCommit(repoRoot: string): string {
	try {
		const commit = gitExec(repoRoot, ["rev-parse", "HEAD"]).trim();
		if (!/^[0-9a-f]{40}$/.test(commit)) throw new WorktreeError("worktree-head-invalid", `git rev-parse HEAD returned non-commit output: ${commit}`);
		return commit;
	} catch (error) {
		if (error instanceof WorktreeError) throw error;
		throw new WorktreeError("worktree-head-failed", `git rev-parse HEAD failed in ${repoRoot}: ${errorMessage(error)}`);
	}
}

function assertBranchDoesNotExist(repoRoot: string, branch: string): void {
	try {
		gitExec(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		// If we reach here, the branch exists.
		throw new WorktreeError("worktree-branch-exists", `Branch ${branch} already exists in ${repoRoot}; refusing to reuse. This usually means a previous F5 step crashed mid-teardown (worktree removed, branch survived). Run \`git branch -D ${branch}\` in ${repoRoot} to recover, or wait for the next pi-multiagent extension startup sweep to attempt branch cleanup.`);
	} catch (error) {
		if (error instanceof WorktreeError) throw error;
		// Non-zero exit from show-ref means branch does not exist — that is what we want.
	}
}

/**
 * Best-effort cleanup of orphan `pi-multiagent/*` branches whose worktree has already
 * been removed. Useful as a sweep belt-and-suspenders pass per repo root: a hard crash
 * between `git worktree remove` and `git branch -D` leaves the branch as a dangling ref.
 * Returns the list of removed branch names plus warnings.
 */
export function pruneOrphanWorktreeBranches(repoRoot: string): { removedBranches: string[]; warnings: string[] } {
	const removed: string[] = [];
	const warnings: string[] = [];
	let branchList: string;
	try {
		branchList = gitExec(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/pi-multiagent/"]);
	} catch (error) {
		warnings.push(`for-each-ref failed: ${errorMessage(error)}`);
		return { removedBranches: removed, warnings };
	}
	let worktreeBranches: Set<string>;
	try {
		const wtList = gitExec(repoRoot, ["worktree", "list", "--porcelain"]);
		worktreeBranches = new Set(wtList.split("\n").filter((line) => line.startsWith("branch ")).map((line) => line.slice("branch refs/heads/".length)));
	} catch (error) {
		warnings.push(`worktree list failed: ${errorMessage(error)}`);
		return { removedBranches: removed, warnings };
	}
	for (const branch of branchList.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("pi-multiagent/"))) {
		if (worktreeBranches.has(branch)) continue;
		try {
			gitExec(repoRoot, ["branch", "-D", branch]);
			removed.push(branch);
		} catch (error) {
			warnings.push(`branch -D ${branch} failed: ${errorMessage(error)}`);
		}
	}
	return { removedBranches: removed, warnings };
}

function createWorktreeTmpDir(): string {
	const base = mkdtempSync(join(tmpdir(), "pi-multiagent-wt-"));
	chmodSync(base, 0o700);
	// `git worktree add` requires the target path to NOT yet exist; remove the
	// mkdtemp-created directory but keep the unique name.
	const target = base;
	bestEffortRemoveDir(target);
	return target;
}

function gitExec(repoRoot: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
		const stderr = err.stderr ? (typeof err.stderr === "string" ? err.stderr : err.stderr.toString("utf8")) : "";
		const cleanedStderr = stderr.trim();
		throw new Error(`git ${args.join(" ")} (cwd=${repoRoot}): ${cleanedStderr || err.message || String(error)}`);
	}
}

function bestEffortRemoveDir(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		// nothing else we can do here
	}
}

function safeRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function isPublicId(value: string): boolean {
	return /^[a-z][a-z0-9-]{0,62}$/.test(value);
}

function isRunId(value: string): boolean {
	return /^r[1-9][0-9]{0,6}$/.test(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------- worktree path containment utility (for callers that may need it) ----------

export function isPathInsideWorktree(state: MutationWorktreeState, candidate: string): boolean {
	const normalizedRoot = resolve(state.worktreePath);
	const normalizedCandidate = resolve(candidate);
	return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

export function worktreePathExists(state: MutationWorktreeState): boolean {
	try {
		return statSync(state.worktreePath).isDirectory();
	} catch {
		return false;
	}
}
