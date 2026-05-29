/** Layer 5: Reproducibility Ledger — replay manifest builder.
 *
 * Produces a serializable descriptor with everything needed to re-launch the same detached run.
 * v0.5 core builds the object only; persisting it to disk and re-executing it are a later increment.
 */

import type { GraphSpecInput } from "../../../multiagent/src/types.ts";
import type { ReplayManifest } from "./types.ts";

export function buildReplayManifest(input: { graph: GraphSpecInput; runHash: string; createdAt: string; harnessContractHash?: string }): ReplayManifest {
	const manifest: ReplayManifest = {
		schemaVersion: 1,
		runHash: input.runHash,
		objective: input.graph.objective,
		graph: input.graph,
		createdAt: input.createdAt,
	};
	if (input.harnessContractHash !== undefined) manifest.harnessContractHash = input.harnessContractHash;
	return manifest;
}
