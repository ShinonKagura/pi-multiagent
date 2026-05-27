/** Per-host persistent registry for detached runs (NEU-A B1a foundation). */

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MutationWorktreeState, RunStatus } from "./types.ts";

/**
 * Phase B1a scope: durable on-disk run record sufficient to (a) detect orphan runs after
 * Pi reload/crash, and (b) clean up leaked F5 worktrees. Tool actions like `list` and
 * `reattach` are deferred to Phase B1b. Artifact mirroring is also deferred — artifacts
 * already live in their own RunArtifactStore tmp dir and have their own retention.
 *
 * On-disk layout:
 *
 *   <state-root>/pi-multiagent/runs/<runId>/
 *     manifest.json   — immutable launch metadata
 *     status.json     — mutable atomic status snapshot
 *     worktrees.json  — per-step worktree state (F5 interlock)
 *     .lock           — PID-based advisory lock (file exists + PID alive ⇒ run is live)
 *
 * State root resolution order:
 *   1. `PI_MULTIAGENT_STATE_DIR` env override
 *   2. `XDG_STATE_HOME` env
 *   3. `~/.local/state`  (Linux/macOS default)
 *   4. fallback to OS tmpdir (degraded — no crash-resume across reboots, but still detects
 *      orphans inside the same boot/session)
 */

const STATE_SUBDIR = "pi-multiagent/runs";
const SCHEMA_VERSION = 1 as const;
const MANIFEST_FILE = "manifest.json";
const STATUS_FILE = "status.json";
const WORKTREES_FILE = "worktrees.json";
const LOCK_FILE = ".lock";

export type PersistedRunStatus = RunStatus | "orphaned" | "unknown";

export interface PersistentRunManifest {
	schemaVersion: 1;
	runId: string;
	createdAt: string;
	invocationCwd: string;
	objective: string;
	ownerPid: number;
	ownerSessionId: string | undefined;
	piVersion: string | undefined;
	terminalRetentionSeconds: number;
}

export interface PersistentRunStatusRecord {
	runId: string;
	status: PersistedRunStatus;
	updatedAt: string;
	terminal: boolean;
	terminalAt: string | undefined;
}

export interface PersistedWorktreeRecord {
	stepId: string;
	worktreePath: string;
	branchName: string;
	baseCommit: string;
	repoRoot: string;
	cleanedUp: boolean;
}

export interface PersistentRunHandle {
	runId: string;
	runDir: string;
	lockPath: string;
	manifest: PersistentRunManifest;
}

export interface OrphanedRunSummary {
	runId: string;
	runDir: string;
	manifest: PersistentRunManifest | undefined;
	status: PersistentRunStatusRecord | undefined;
	worktrees: PersistedWorktreeRecord[];
	wasLocked: boolean;
	staleLockPid: number | undefined;
	manifestParseError: string | undefined;
}

// ------------------------------------------------------------------ state root

export function resolveStateRoot(): string {
	const override = process.env.PI_MULTIAGENT_STATE_DIR;
	if (override && override.length > 0) return resolve(override);
	const xdg = process.env.XDG_STATE_HOME;
	if (xdg && xdg.length > 0) return resolve(xdg, "pi-multiagent");
	const home = homedir();
	if (home && home.length > 0) return resolve(home, ".local", "state", "pi-multiagent");
	return resolve(tmpdir(), "pi-multiagent-state");
}

export function runsRoot(): string {
	// PI_MULTIAGENT_STATE_DIR override is treated as the runs/ root itself for test scoping
	// (so callers can point at a disposable tmp dir); otherwise we keep the canonical
	// <state-root>/pi-multiagent/runs/ subdirectory layout.
	return process.env.PI_MULTIAGENT_STATE_DIR ? resolveStateRoot() : join(resolveStateRoot(), "runs");
}

function runDirFor(runId: string): string {
	return join(runsRoot(), runId);
}

// ------------------------------------------------------------------ lifecycle

export interface CreatePersistentRunInput {
	runId: string;
	manifest: Omit<PersistentRunManifest, "schemaVersion">;
}

export function createPersistentRun(input: CreatePersistentRunInput): PersistentRunHandle | undefined {
	try {
		const runDir = runDirFor(input.runId);
		// I2 (partial) FIX: defense against r1-collision after Pi-restart.
		// runId is process-local ("r1", "r2", ...). If a previous Pi process crashed
		// while owning runs/r1/ and we now want to claim runs/r1/ in a fresh process,
		// detect the existing manifest and refuse to silently overwrite a foreign-pid
		// run dir. The full fix (proper namespace, e.g. <pid>-r1/) requires upstream
		// PI2 decision; this defense only prevents the worst silent-clobber case.
		try {
			const existing = readManifest(runDir);
			if (existing && existing.ownerPid !== input.manifest.ownerPid) {
				// Existing run dir owned by a different pid. Check if that pid is alive;
				// if alive we definitely must not clobber. If dead (orphan), still refuse:
				// operator must explicitly cleanup before reusing this runId namespace.
				return undefined;
			}
		} catch {
			// no existing manifest or unreadable; safe to proceed and create fresh
		}
		mkdirSync(runDir, { recursive: true });
		const lockPath = join(runDir, LOCK_FILE);
		const lockAcquired = tryAcquireLock(lockPath, input.manifest.ownerPid);
		if (!lockAcquired) return undefined;
		const manifest: PersistentRunManifest = { ...input.manifest, schemaVersion: SCHEMA_VERSION };
		atomicWriteJson(join(runDir, MANIFEST_FILE), manifest);
		atomicWriteJson(join(runDir, STATUS_FILE), { runId: input.runId, status: "running", updatedAt: manifest.createdAt, terminal: false, terminalAt: undefined } satisfies PersistentRunStatusRecord);
		atomicWriteJson(join(runDir, WORKTREES_FILE), [] satisfies PersistedWorktreeRecord[]);
		return { runId: input.runId, runDir, lockPath, manifest };
	} catch {
		// Degraded mode: persistence not available; runs continue in memory only.
		return undefined;
	}
}

export function updatePersistentRunStatus(handle: PersistentRunHandle | undefined, status: PersistedRunStatus, terminal: boolean): void {
	if (!handle) return;
	try {
		const now = new Date().toISOString();
		const record: PersistentRunStatusRecord = { runId: handle.runId, status, updatedAt: now, terminal, terminalAt: terminal ? now : undefined };
		atomicWriteJson(join(handle.runDir, STATUS_FILE), record);
	} catch {
		// best-effort; never throw from persistence path
	}
}

export function recordWorktreeForStep(handle: PersistentRunHandle | undefined, record: Omit<PersistedWorktreeRecord, "cleanedUp">): void {
	if (!handle) return;
	mutateWorktrees(handle, (rows) => {
		const filtered = rows.filter((row) => row.stepId !== record.stepId);
		filtered.push({ ...record, cleanedUp: false });
		return filtered;
	});
}

export function markWorktreeCleanedUp(handle: PersistentRunHandle | undefined, stepId: string): void {
	if (!handle) return;
	mutateWorktrees(handle, (rows) => rows.map((row) => (row.stepId === stepId ? { ...row, cleanedUp: true } : row)));
}

export function releasePersistentRun(handle: PersistentRunHandle | undefined): void {
	if (!handle) return;
	try {
		rmSync(handle.lockPath, { force: true });
	} catch {
		// ignore
	}
}

export function deletePersistentRun(handle: PersistentRunHandle | undefined): void {
	if (!handle) return;
	try {
		rmSync(handle.runDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// ------------------------------------------------------------------ sweep

export interface SweepInput {
	now?: Date;
	pruneWorktrees?: (records: PersistedWorktreeRecord[]) => { cleaned: string[]; warnings: string[] };
}

export interface SweepResult {
	scannedRuns: number;
	orphanedRuns: OrphanedRunSummary[];
	prunedWorktrees: number;
	deletedExpiredRuns: number;
	warnings: string[];
}

/**
 * Walk the persistent runs root, classify orphans (lock missing or owner PID dead), invoke
 * the worktree pruner for each orphan's recorded worktrees, and delete orphan runs whose
 * retention has expired. Live runs (lock held by a live PID) are left untouched.
 *
 * The pruner is injected so this module stays free of git dependencies. The default
 * extension wiring passes a callback that calls into `mutation-worktree.ts`.
 */
export function sweepRunsRoot(input: SweepInput = {}): SweepResult {
	const now = input.now ?? new Date();
	const root = runsRoot();
	const result: SweepResult = { scannedRuns: 0, orphanedRuns: [], prunedWorktrees: 0, deletedExpiredRuns: 0, warnings: [] };
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return result;
	}
	for (const entry of entries) {
		const runDir = join(root, entry);
		try {
			if (!statSync(runDir).isDirectory()) continue;
		} catch {
			continue;
		}
		result.scannedRuns += 1;
		const summary = classifyRun(entry, runDir);
		if (summary.wasLocked && summary.staleLockPid === undefined) {
			// Lock held by a live PID — skip; another process owns this run.
			continue;
		}
		result.orphanedRuns.push(summary);
		if (summary.worktrees.length > 0 && input.pruneWorktrees) {
			const pending = summary.worktrees.filter((row) => !row.cleanedUp);
			if (pending.length > 0) {
				try {
					const outcome = input.pruneWorktrees(pending);
					result.prunedWorktrees += outcome.cleaned.length;
					for (const warning of outcome.warnings) result.warnings.push(`run ${entry}: ${warning}`);
					if (outcome.cleaned.length > 0) {
						const cleanedSet = new Set(outcome.cleaned);
						const updated = summary.worktrees.map((row) => (cleanedSet.has(row.stepId) ? { ...row, cleanedUp: true } : row));
						try {
							atomicWriteJson(join(runDir, WORKTREES_FILE), updated);
						} catch {
							result.warnings.push(`run ${entry}: failed to update worktrees.json after prune`);
						}
					}
				} catch (error) {
					result.warnings.push(`run ${entry}: worktree prune callback threw: ${errorMessage(error)}`);
				}
			}
		}
		const retention = summary.manifest?.terminalRetentionSeconds;
		if (summary.status?.terminal && summary.status.terminalAt && typeof retention === "number") {
			const expiry = Date.parse(summary.status.terminalAt) + retention * 1000;
			if (Number.isFinite(expiry) && now.getTime() >= expiry) {
				try {
					rmSync(runDir, { recursive: true, force: true });
					result.deletedExpiredRuns += 1;
				} catch (error) {
					result.warnings.push(`run ${entry}: failed to delete expired run dir: ${errorMessage(error)}`);
				}
			}
		} else if (summary.wasLocked && summary.staleLockPid !== undefined) {
			// Stale lock from a dead owner — remove the lock file so the run dir reflects orphan state.
			try {
				rmSync(join(runDir, LOCK_FILE), { force: true });
			} catch {
				// ignore
			}
		}
	}
	return result;
}

// ------------------------------------------------------------------ internals

function classifyRun(runId: string, runDir: string): OrphanedRunSummary {
	const summary: OrphanedRunSummary = { runId, runDir, manifest: undefined, status: undefined, worktrees: [], wasLocked: false, staleLockPid: undefined, manifestParseError: undefined };
	const lockPath = join(runDir, LOCK_FILE);
	try {
		const lockData = readFileSync(lockPath, "utf8").trim();
		const pid = Number.parseInt(lockData, 10);
		summary.wasLocked = true;
		if (Number.isFinite(pid) && pid > 0 && pid === process.pid) {
			// Lock held by us — definitely live.
			summary.staleLockPid = undefined;
		} else if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
			summary.staleLockPid = undefined;
		} else {
			summary.staleLockPid = pid;
		}
	} catch {
		summary.wasLocked = false;
	}
	try {
		const raw = readFileSync(join(runDir, MANIFEST_FILE), "utf8");
		const parsed = JSON.parse(raw);
		if (isManifest(parsed)) summary.manifest = parsed;
		else summary.manifestParseError = "manifest shape rejected";
	} catch (error) {
		summary.manifestParseError = errorMessage(error);
	}
	try {
		const raw = readFileSync(join(runDir, STATUS_FILE), "utf8");
		const parsed = JSON.parse(raw);
		if (isStatusRecord(parsed)) summary.status = parsed;
	} catch {
		// no status yet
	}
	try {
		const raw = readFileSync(join(runDir, WORKTREES_FILE), "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) summary.worktrees = parsed.filter(isWorktreeRecord);
	} catch {
		// no worktrees recorded
	}
	return summary;
}

function tryAcquireLock(lockPath: string, pid: number): boolean {
	try {
		const fd = openSync(lockPath, "wx");
		try {
			writeSync(fd, `${pid}\n`);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST") return false;
		// Existing lock: take it over only if owner PID is dead (orphan).
		try {
			const existing = readFileSync(lockPath, "utf8").trim();
			const existingPid = Number.parseInt(existing, 10);
			if (Number.isFinite(existingPid) && existingPid > 0 && existingPid !== process.pid && isPidAlive(existingPid)) return false;
			rmSync(lockPath, { force: true });
			const fd = openSync(lockPath, "wx");
			try {
				writeSync(fd, `${pid}\n`);
			} finally {
				closeSync(fd);
			}
			return true;
		} catch {
			return false;
		}
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// EPERM means the PID is alive but we don't own it — still alive.
		return code === "EPERM";
	}
}

/**
 * Synchronous read-modify-write of `worktrees.json` for a single run handle.
 *
 * CALLER INVARIANT: must not be called reentrantly for the same handle. All current
 * callers (`recordWorktreeForStep`, `markWorktreeCleanedUp`) run in synchronous blocks
 * of `DetachedRun.runStep` between explicit `await` points, so two updates for the same
 * run cannot interleave today. If a future change introduces async callers (timer-fired
 * updates, RPC-pushed worktree state, parallel teardown), add a per-handle Promise lock
 * or migrate to an in-memory record + single-flush-on-terminal pattern — the current
 * "best-effort" catch would otherwise silently drop a worktree record and create the
 * exact F5 leak this module exists to prevent.
 */
function mutateWorktrees(handle: PersistentRunHandle, mutator: (rows: PersistedWorktreeRecord[]) => PersistedWorktreeRecord[]): void {
	try {
		const path = join(handle.runDir, WORKTREES_FILE);
		let rows: PersistedWorktreeRecord[] = [];
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) rows = parsed.filter(isWorktreeRecord);
		} catch {
			// start from empty
		}
		const next = mutator(rows);
		atomicWriteJson(path, next);
	} catch {
		// best-effort — see invariant note above; silent loss here is a known risk if the
		// reentrancy invariant is ever violated.
	}
}

function atomicWriteJson(path: string, value: unknown): void {
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

function isManifest(value: unknown): value is PersistentRunManifest {
	if (!isRecord(value)) return false;
	return value.schemaVersion === SCHEMA_VERSION && typeof value.runId === "string" && typeof value.createdAt === "string" && typeof value.invocationCwd === "string" && typeof value.objective === "string" && typeof value.ownerPid === "number" && typeof value.terminalRetentionSeconds === "number";
}

function isStatusRecord(value: unknown): value is PersistentRunStatusRecord {
	if (!isRecord(value)) return false;
	return typeof value.runId === "string" && typeof value.status === "string" && typeof value.updatedAt === "string" && typeof value.terminal === "boolean";
}

function isWorktreeRecord(value: unknown): value is PersistedWorktreeRecord {
	if (!isRecord(value)) return false;
	return typeof value.stepId === "string" && typeof value.worktreePath === "string" && typeof value.branchName === "string" && typeof value.baseCommit === "string" && typeof value.repoRoot === "string" && typeof value.cleanedUp === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ helpers re-exported for callers

export function readManifest(runDir: string): PersistentRunManifest | undefined {
	try {
		const raw = readFileSync(join(runDir, MANIFEST_FILE), "utf8");
		const parsed = JSON.parse(raw);
		return isManifest(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function readPersistedStatus(runDir: string): PersistentRunStatusRecord | undefined {
	try {
		const raw = readFileSync(join(runDir, STATUS_FILE), "utf8");
		const parsed = JSON.parse(raw);
		return isStatusRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function readPersistedWorktrees(runDir: string): PersistedWorktreeRecord[] {
	try {
		const raw = readFileSync(join(runDir, WORKTREES_FILE), "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isWorktreeRecord) : [];
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------ B1b helpers

export interface PersistedRunListing {
	runId: string;
	runDir: string;
	manifest: PersistentRunManifest | undefined;
	status: PersistentRunStatusRecord | undefined;
	worktrees: PersistedWorktreeRecord[];
	lockHeldByPid: number | undefined;
	lockHolderAlive: boolean;
	lockExistedButStale: boolean;
	artifactPaths: { name: string; path: string; size: number }[];
}

/**
 * Walk the persistent runs root and return one summary per run dir. Read-only:
 * does not mutate locks, status, or worktrees. Includes manifest/status parse
 * errors as undefined fields so the caller can decide how to surface them.
 */
export function listPersistedRuns(): PersistedRunListing[] {
	const out: PersistedRunListing[] = [];
	const root = runsRoot();
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return out;
	}
	for (const entry of entries.sort()) {
		const runDir = join(root, entry);
		try {
			if (!statSync(runDir).isDirectory()) continue;
		} catch {
			continue;
		}
		const listing = readListing(entry, runDir);
		if (listing) out.push(listing);
	}
	return out;
}

function readListing(runId: string, runDir: string): PersistedRunListing | undefined {
	const manifest = readManifest(runDir);
	const status = readPersistedStatus(runDir);
	const worktrees = readPersistedWorktrees(runDir);
	const lockPath = join(runDir, LOCK_FILE);
	let lockHeldByPid: number | undefined;
	let lockHolderAlive = false;
	let lockExistedButStale = false;
	try {
		const lockData = readFileSync(lockPath, "utf8").trim();
		const pid = Number.parseInt(lockData, 10);
		if (Number.isFinite(pid) && pid > 0) {
			lockHeldByPid = pid;
			lockHolderAlive = isPidAlive(pid);
			lockExistedButStale = !lockHolderAlive;
		}
	} catch {
		lockHeldByPid = undefined;
		lockHolderAlive = false;
		lockExistedButStale = false;
	}
	const artifactPaths = listArtifactPaths(runDir);
	return { runId, runDir, manifest, status, worktrees, lockHeldByPid, lockHolderAlive, lockExistedButStale, artifactPaths };
}

function listArtifactPaths(runDir: string): { name: string; path: string; size: number }[] {
	const out: { name: string; path: string; size: number }[] = [];
	const artifactsDir = join(runDir, "artifacts");
	let entries: string[];
	try {
		entries = readdirSync(artifactsDir);
	} catch {
		return out;
	}
	for (const entry of entries.sort()) {
		const path = join(artifactsDir, entry);
		try {
			const stat = statSync(path);
			if (stat.isFile()) out.push({ name: entry, path, size: stat.size });
		} catch {
			continue;
		}
	}
	return out;
}

/** Read-only reattach: look up a single run by id. Returns undefined if not present. */
export function readPersistedRun(runId: string): PersistedRunListing | undefined {
	const runDir = runDirFor(runId);
	try {
		if (!statSync(runDir).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	return readListing(runId, runDir);
}

/**
 * G1: mirror a single artifact file into the persistent run dir. Best-effort copy;
 * failures record diagnostic and do not throw. Called from DetachedRun after writing
 * the original artifact to its tmp RunArtifactStore so reattach can find evidence
 * after the original tmp store is gone.
 */
export function mirrorArtifactToRunDir(handle: PersistentRunHandle | undefined, sourcePath: string, displayName: string): void {
	if (!handle) return;
	try {
		const artifactsDir = join(handle.runDir, "artifacts");
		mkdirSync(artifactsDir, { recursive: true });
		const destination = join(artifactsDir, sanitizeArtifactName(displayName));
		const data = readFileSync(sourcePath);
		writeFileSync(destination, data, { mode: 0o600 });
	} catch {
		// best-effort; artifact still exists in the original tmp RunArtifactStore until retention.
	}
}

function sanitizeArtifactName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "unnamed";
}
