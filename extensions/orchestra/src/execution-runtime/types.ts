/** Layer 3: Execution Runtime — hb-orchestra graph mapping contracts.
 *
 * v0.5 scope: convert resolved profiles into inherited detached `agent_team`
 * start graph shapes. This layer does not launch children directly.
 */

import type { GraphSpecInput, StepOutputLimitSpec, TeamLimits, WorktreeIsolationMode, WorktreeSetupSpec } from "../../../multiagent/src/types.ts";
import type { ProfileDiagnostic, ResolvedProfile } from "../profile-engine/types.ts";

export interface ProfileDetachedGraphOptions {
	/** Overall objective for the detached `agent_team` run. */
	objective: string;
	/** Concrete delegated task given to each profile member. */
	task: string;
	/** Required when profile tools include edit/write. Applied to every generated step. */
	mutationScope?: string;
	cwd?: string;
	isolation?: WorktreeIsolationMode;
	worktreeSetup?: WorktreeSetupSpec;
	outputLimit?: StepOutputLimitSpec;
	limits?: Partial<TeamLimits>;
}

export interface ProfileDetachedGraphResult {
	action: "start";
	graph: GraphSpecInput | undefined;
	diagnostics: ProfileDiagnostic[];
	profile: ResolvedProfile;
}
