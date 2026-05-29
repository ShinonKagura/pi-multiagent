/** Layer 6: Compat Surface — contracts.
 *
 * v0.5 minimal scope: map a single resolved Layer-1 persona plus
 * pi-subagents-compatible `Agent()` invocation params into one detached
 * `agent_team` start graph. The mapper is pure; tool/slash-command
 * registration and the `runAgentTeam` call live in `extensions/orchestra/index.ts`.
 *
 * Foreground inline-result waiting, `get_subagent_result`, `steer_subagent`,
 * and `/profile` are deferred L6 increments; this slice delivers detached
 * `Agent()` / `/agent` persona invocation by name.
 */

import type { WorktreeIsolationMode } from "../../../multiagent/src/types.ts";
import type { ProfileDiagnostic } from "../profile-engine/types.ts";

/** pi-subagents-compatible `Agent()` invocation subset relevant to graph construction.
 *
 * Fields such as `run_in_background`, `resume`, and `inherit_context` affect
 * caller behaviour in `index.ts`, not the detached graph shape, so they are not
 * part of this pure mapping contract. */
export interface AgentInvocation {
	/** Persona key resolved by Layer 1 (`.pi/agents/<name>.md`). */
	subagent_type: string;
	/** Concrete task given to the child. Maps to the single step's task. */
	prompt: string;
	/** Optional run objective / short label. Defaults to a persona-derived objective. */
	description?: string;
	/** Optional model lane override; falls back to the persona's frontmatter model. */
	model?: string;
	/** Optional thinking lane override; falls back to the persona's frontmatter thinking. */
	thinking?: string;
	/** Optional strict child tool allowlist; falls back to the persona's frontmatter tools. */
	tools?: string[];
	/** Required when the effective tools include edit/write. */
	mutationScope?: string;
	/** Optional per-step worktree isolation for mutation-capable invocations. */
	isolation?: WorktreeIsolationMode;
}

/** Pure result of mapping a persona + invocation to a detached start graph. */
export interface AgentDetachedGraphResult {
	action: "start";
	/** Undefined when validation produced a blocking error. */
	graph: import("../../../multiagent/src/types.ts").GraphSpecInput | undefined;
	diagnostics: ProfileDiagnostic[];
	subagent_type: string;
}
