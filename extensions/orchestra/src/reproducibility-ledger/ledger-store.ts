/** Layer 5: Reproducibility Ledger — on-disk replay store.
 *
 * Persists replay manifests in hb-orchestra's OWN state dir (NOT the inherited substrate `runs/`
 * dir, which the multiagent runtime owns). Keyed by the stable `run_hash` so replay survives the
 * per-process runId namespace (OPEN-2); a small index.jsonl maps recent runIds -> run_hash for
 * convenience lookups. All writes are best-effort and atomic; they never block or fail a run.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ReplayManifest } from "./types.ts";

const INDEX_FILE = "index.jsonl";

/** hb-orchestra-owned ledger dir. Order: $HB_ORCHESTRA_STATE_DIR, $XDG_STATE_HOME, ~/.local/state. */
export function resolveReplayLedgerDir(): string {
	const override = process.env.HB_ORCHESTRA_STATE_DIR?.trim();
	if (override) return join(override, "replay");
	const xdg = process.env.XDG_STATE_HOME?.trim();
	if (xdg) return join(xdg, "hb-orchestra", "replay");
	return join(homedir(), ".local", "state", "hb-orchestra", "replay");
}

export interface ReplayWriteResult {
	ok: boolean;
	path?: string;
	error?: string;
}

export function writeReplayManifest(manifest: ReplayManifest, runId: string, ledgerDir: string = resolveReplayLedgerDir()): ReplayWriteResult {
	try {
		mkdirSync(ledgerDir, { recursive: true });
		const file = join(ledgerDir, `${manifest.runHash}.json`);
		const tmp = `${file}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, file);
		appendFileSync(join(ledgerDir, INDEX_FILE), `${JSON.stringify({ runId, runHash: manifest.runHash, objective: manifest.objective, createdAt: manifest.createdAt })}\n`, { encoding: "utf8" });
		return { ok: true, path: file };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

export interface ReplayLoadResult {
	manifest?: ReplayManifest;
	resolvedBy?: "hash" | "hash-prefix" | "runId";
	diagnostic?: string;
}

export function loadReplayManifest(idOrHash: string, ledgerDir: string = resolveReplayLedgerDir()): ReplayLoadResult {
	const id = idOrHash.trim();
	if (!id) return { diagnostic: "replay id is empty" };
	if (!existsSync(ledgerDir)) return { diagnostic: `no replay ledger at ${ledgerDir}` };

	const exact = join(ledgerDir, `${id}.json`);
	if (looksLikeHexId(id) && existsSync(exact)) return finalize(exact, "hash");

	if (looksLikeHexId(id)) {
		const matches = listManifestFiles(ledgerDir).filter((name) => name.toLowerCase().startsWith(id.toLowerCase()));
		if (matches.length === 1) return finalize(join(ledgerDir, matches[0]), "hash-prefix");
		if (matches.length > 1) return { diagnostic: `ambiguous run_hash prefix ${JSON.stringify(id)} (${matches.length} matches)` };
	}

	const hash = resolveRunIdToHash(id, ledgerDir);
	if (hash) {
		const file = join(ledgerDir, `${hash}.json`);
		if (existsSync(file)) return finalize(file, "runId");
	}
	return { diagnostic: `no replay manifest for ${JSON.stringify(id)} (use the run_hash from the start result)` };

	function finalize(file: string, resolvedBy: "hash" | "hash-prefix" | "runId"): ReplayLoadResult {
		const read = readManifest(file);
		return read.manifest ? { manifest: read.manifest, resolvedBy } : { diagnostic: read.diagnostic };
	}
}

function resolveRunIdToHash(runId: string, ledgerDir: string): string | undefined {
	const indexPath = join(ledgerDir, INDEX_FILE);
	if (!existsSync(indexPath)) return undefined;
	let hash: string | undefined;
	for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { runId?: unknown; runHash?: unknown };
			if (entry.runId === runId && typeof entry.runHash === "string") hash = entry.runHash; // last match wins
		} catch {
			/* skip malformed index line */
		}
	}
	return hash;
}

function readManifest(file: string): { manifest?: ReplayManifest; diagnostic?: string } {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!isManifest(parsed)) return { diagnostic: `replay manifest at ${file} has an unexpected shape` };
		return { manifest: parsed };
	} catch (error) {
		return { diagnostic: `could not read replay manifest at ${file}: ${String(error)}` };
	}
}

function isManifest(value: unknown): value is ReplayManifest {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return v.schemaVersion === 1 && typeof v.runHash === "string" && typeof v.objective === "string" && typeof v.graph === "object" && v.graph !== null;
}

function listManifestFiles(ledgerDir: string): string[] {
	try {
		if (!statSync(ledgerDir).isDirectory()) return [];
		return readdirSync(ledgerDir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

function looksLikeHexId(id: string): boolean {
	// Any all-hex string is treated as a run_hash or run_hash prefix. runIds (`r1`, `r2`, ...) contain
	// a non-hex character and therefore fall through to the runId index lookup.
	return /^[0-9a-f]+$/i.test(id);
}
