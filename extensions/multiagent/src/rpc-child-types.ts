/** Shared RPC child controller types. */

import type { AgentInvocationDefaults, ResolvedAgent, StepOutputLimitSpec, StepStatus, TeamLimits } from "./types.ts";

export interface RpcChildControllerOptions {
	agent: ResolvedAgent;
	defaults: AgentInvocationDefaults;
	limits: TeamLimits;
	cwd: string;
	promptPath: string;
	spawnProcess?: import("./child-launch.ts").SpawnProcess;
	ackTimeoutMs?: number;
	/** Per-step output truncation knobs. Clamps to package-level caps (MAX_STEP_OUTPUT_BYTES / MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP). Omit to use the package defaults. */
	outputLimit?: StepOutputLimitSpec;
	onEvent: (input: { type: "rpc" | "assistant_final" | "tool" | "diagnostic" | "parent_message" | "ui"; label?: string; preview?: string; status?: string }) => void;
	onText?: (text: string) => void;
}

export interface RpcStepResult {
	status: StepStatus;
	text: string;
	assistantFinals: string[];
	stderr: string;
	errorMessage: string | undefined;
	nonFinalText?: string;
}
