/** Layer 4: Harness Contracts — read-only loader + summary.
 *
 * Discovers an opt-in harness contract (`.pi/harness/contract.json` or `.agents/harness/contract.json`)
 * and validates the governance subset. NEVER writes anything (ARCHITECTURE I6): hb-orchestra reads
 * harness files if present; the project owns and produces them.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { HarnessContract, HarnessContractLookup, HarnessDiagnostic, HarnessDiscoveryInput, HarnessSource } from "./types.ts";
import { HARNESS_CONTRACT_FILENAMES, HARNESS_SEARCH_PATHS } from "./types.ts";

export function findHarnessContract(input: HarnessDiscoveryInput): HarnessContractLookup {
	const diagnostics: HarnessDiagnostic[] = [];
	const searchedDirs: string[] = [];
	for (const { relative, source } of HARNESS_SEARCH_PATHS) {
		const dir = join(input.invocationCwd, relative);
		searchedDirs.push(dir);
		if (!existsSync(dir) || !isDirectory(dir, diagnostics)) continue;
		const contractPath = firstExistingContract(dir);
		if (!contractPath) continue;
		const contract = loadContract(contractPath, dir, source, diagnostics);
		// A present-but-invalid contract stops the search: do not silently fall through to a lower-priority
		// harness, which would mask the operator's broken project contract.
		return { contract, diagnostics, searchedDirs };
	}
	// Harness is optional; absence is not an error.
	return { contract: undefined, diagnostics, searchedDirs };
}

/** One-line, side-effect-free summary for an operator command / notice. */
export function summarizeHarnessContract(lookup: HarnessContractLookup): string {
	const errors = lookup.diagnostics.filter((d) => d.severity === "error");
	if (!lookup.contract) {
		if (errors.length > 0) return `Harness contract invalid: ${errors.map((d) => d.message).join("; ")}`;
		return `No harness contract found (searched: ${lookup.searchedDirs.join(", ") || "none"}).`;
	}
	const c = lookup.contract;
	const parts: string[] = [`Harness contract (${c.source}) at ${c.contractPath}`];
	if (c.mutationScope !== undefined) parts.push(`mutationScope=${JSON.stringify(c.mutationScope)}`);
	if (c.mutationAllowed !== undefined) parts.push(`mutationAllowed=${c.mutationAllowed}`);
	if (c.allowedPaths) parts.push(`allowedPaths=${c.allowedPaths.length}`);
	if (c.forbiddenPaths) parts.push(`forbiddenPaths=${c.forbiddenPaths.length}`);
	if (c.approvalGateRequired !== undefined) parts.push(`approvalGate=${c.approvalGateRequired ? "required" : "off"}`);
	if (c.reviewGateRequired !== undefined) parts.push(`reviewGate=${c.reviewGateRequired ? "required" : "off"}`);
	if (c.systemPromptFiles) parts.push(`systemPromptFiles=${c.systemPromptFiles.length}`);
	if (c.planPacketPath !== undefined) parts.push(`planPacket=${JSON.stringify(c.planPacketPath)}`);
	const warns = lookup.diagnostics.filter((d) => d.severity !== "error");
	if (warns.length > 0) parts.push(`(${warns.length} warning${warns.length === 1 ? "" : "s"})`);
	return parts.join(" · ");
}

function firstExistingContract(dir: string): string | undefined {
	for (const name of HARNESS_CONTRACT_FILENAMES) {
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function loadContract(contractPath: string, sourceDir: string, source: HarnessSource, diagnostics: HarnessDiagnostic[]): HarnessContract | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(contractPath, "utf8"));
	} catch (error) {
		diagnostics.push({ code: "harness-contract-unparseable", message: `Could not parse harness contract JSON: ${String(error)}`, path: contractPath, severity: "error" });
		return undefined;
	}
	if (!isRecord(raw)) {
		diagnostics.push({ code: "harness-contract-not-object", message: "Harness contract must be a JSON object.", path: contractPath, severity: "error" });
		return undefined;
	}

	const str = (key: string): string | undefined => {
		const value = raw[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string") return invalid(key, "a string");
		return value;
	};
	const bool = (key: string): boolean | undefined => {
		const value = raw[key];
		if (value === undefined) return undefined;
		if (typeof value !== "boolean") return invalid(key, "a boolean");
		return value;
	};
	const strArr = (key: string): string[] | undefined => {
		const value = raw[key];
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return invalid(key, "a string array");
		return value as string[];
	};
	function invalid(key: string, expected: string): undefined {
		diagnostics.push({ code: "harness-contract-field-invalid", message: `Harness contract field ${key} must be ${expected}.`, path: contractPath, severity: "warning" });
		return undefined;
	}

	const contract: HarnessContract = { source, sourceDir, contractPath, raw };
	const mutationAllowed = bool("mutationAllowed");
	if (mutationAllowed !== undefined) contract.mutationAllowed = mutationAllowed;
	const mutationScope = str("mutationScope");
	if (mutationScope !== undefined) contract.mutationScope = mutationScope;
	const allowedPaths = strArr("allowedPaths");
	if (allowedPaths !== undefined) contract.allowedPaths = allowedPaths;
	const forbiddenPaths = strArr("forbiddenPaths");
	if (forbiddenPaths !== undefined) contract.forbiddenPaths = forbiddenPaths;
	const externalSideEffectsAllowed = bool("externalSideEffectsAllowed");
	if (externalSideEffectsAllowed !== undefined) contract.externalSideEffectsAllowed = externalSideEffectsAllowed;
	const approvalGateRequired = bool("approvalGateRequired");
	if (approvalGateRequired !== undefined) contract.approvalGateRequired = approvalGateRequired;
	const reviewGateRequired = bool("reviewGateRequired");
	if (reviewGateRequired !== undefined) contract.reviewGateRequired = reviewGateRequired;
	const artifactReadyBeforeReview = bool("artifactReadyBeforeReview");
	if (artifactReadyBeforeReview !== undefined) contract.artifactReadyBeforeReview = artifactReadyBeforeReview;
	const systemPromptFiles = strArr("systemPromptFiles");
	if (systemPromptFiles !== undefined) contract.systemPromptFiles = systemPromptFiles;
	const planPacketPath = str("planPacketPath");
	if (planPacketPath !== undefined) contract.planPacketPath = planPacketPath;
	return contract;
}

function isDirectory(dir: string, diagnostics: HarnessDiagnostic[]): boolean {
	try {
		if (statSync(dir).isDirectory()) return true;
		diagnostics.push({ code: "harness-dir-not-directory", message: "Harness search path exists but is not a directory.", path: dir, severity: "warning" });
		return false;
	} catch (error) {
		diagnostics.push({ code: "harness-dir-unreadable", message: `Could not stat harness directory: ${String(error)}`, path: dir, severity: "warning" });
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
