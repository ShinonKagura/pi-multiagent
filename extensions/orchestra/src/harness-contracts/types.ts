/** Layer 4: Harness Contracts — types.
 *
 * Read-only governance a project may opt into under `.pi/harness/` (project) or `.agents/harness/`
 * (workspace). hb-orchestra READS these contracts; it never writes them (ARCHITECTURE I6: the harness
 * is project-owned, optional governance — not an execution monopoly and not a path hb-orchestra
 * installs or mutates).
 *
 * v0.5 scope: discover and validate a small machine-readable JSON contract whose governance fields
 * mirror the harness plan-packet `scope` / `approval_gate` / `artifact_readiness` blocks. Parsing the
 * full (nested YAML) PlanPacket and injecting/enforcing the contract into runs are later increments.
 */

export interface HarnessDiagnostic {
	code: string;
	message: string;
	path: string | undefined;
	severity: "info" | "warning" | "error";
}

export type HarnessSource = "project" | "workspace";

/** Governance subset hb-orchestra understands. All fields optional: a project provides what it wants. */
export interface HarnessContract {
	/** `.pi/harness` -> "project"; `.agents/harness` -> "workspace". */
	source: HarnessSource;
	/** The harness directory the contract was read from. */
	sourceDir: string;
	/** The contract file path. */
	contractPath: string;
	mutationAllowed?: boolean;
	/** Free-form mutation scope description (mirrors plan-packet `scope.mutation_scope`). */
	mutationScope?: string;
	allowedPaths?: string[];
	forbiddenPaths?: string[];
	externalSideEffectsAllowed?: boolean;
	approvalGateRequired?: boolean;
	reviewGateRequired?: boolean;
	artifactReadyBeforeReview?: boolean;
	/** Files (relative to `sourceDir`) whose text a future increment injects into agent system prompts. */
	systemPromptFiles?: string[];
	/** Optional pointer to a PlanPacket (yaml/md). Surfaced, not parsed, in v0.5. */
	planPacketPath?: string;
	/** The parsed raw contract object, for forward-compatible consumers. */
	raw: Record<string, unknown>;
}

export interface HarnessDiscoveryInput {
	invocationCwd: string;
}

export interface HarnessContractLookup {
	/** Undefined when no harness contract is present (harness is optional) or the contract was invalid. */
	contract: HarnessContract | undefined;
	diagnostics: HarnessDiagnostic[];
	searchedDirs: string[];
}

/** v0.5 search order: project `.pi/harness` first, then workspace `.agents/harness`. Read-only. */
export const HARNESS_SEARCH_PATHS = [
	{ relative: ".pi/harness", source: "project" as const },
	{ relative: ".agents/harness", source: "workspace" as const },
] as const;

/** Candidate contract filenames within a harness directory, in priority order. */
export const HARNESS_CONTRACT_FILENAMES = ["contract.json", "harness.json"] as const;
