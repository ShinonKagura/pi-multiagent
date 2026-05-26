/** Mutable per-step detached-run state. */

import type { RpcChildController } from "./rpc-child-controller.ts";
import type { MutationWorktreeState, StepOutput, StepStatus, TeamStepSpec, WorktreeTeardownEvidence } from "./types.ts";

export interface StepState {
	spec: TeamStepSpec;
	status: StepStatus;
	startedAt: string | undefined;
	endedAt: string | undefined;
	errorMessage: string | undefined;
	output: StepOutput | undefined;
	finalText: string | undefined;
	assistantFinals: string[];
	liveText: string;
	liveTextEventChars: number;
	controller: RpcChildController | undefined;
	promise: Promise<void> | undefined;
	worktreeState: MutationWorktreeState | undefined;
	worktreeEvidence: WorktreeTeardownEvidence | undefined;
}

export function createPendingStepState(spec: TeamStepSpec): StepState {
	return { spec, status: "pending", startedAt: undefined, endedAt: undefined, errorMessage: undefined, output: undefined, finalText: undefined, assistantFinals: [], liveText: "", liveTextEventChars: 0, controller: undefined, promise: undefined, worktreeState: undefined, worktreeEvidence: undefined };
}
