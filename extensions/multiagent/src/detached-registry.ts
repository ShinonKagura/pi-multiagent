/** Retained detached-run registry. */

import type { DetachedRun } from "./detached-run.ts";

// Process-global singleton. orchestra and multiagent load as two separate `-e` extensions, which can
// instantiate this module twice (two module graphs => two Maps). A module-local `new Map()` then
// split-brains the registry: orchestra registers a run via runAgentTeam(start) into its copy, while
// the agent_team tool's run_status / step_result / message / cancel read the other copy and report
// run-not-found (list still works because it also reads persistent disk state). Anchoring the Map on
// globalThis makes it a true per-process singleton shared by every module instance.
const REGISTRY_KEY = "__hbOrchestraDetachedRunRegistry__";
const globalRegistry = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, DetachedRun> };
const registry: Map<string, DetachedRun> = (globalRegistry[REGISTRY_KEY] ??= new Map<string, DetachedRun>());

export function registerDetachedRun(run: DetachedRun): void {
	registry.set(run.id, run);
}

export function getDetachedRun(runId: string | undefined): DetachedRun | undefined {
	return runId ? registry.get(runId) : undefined;
}

export function forgetDetachedRun(runId: string): void {
	registry.delete(runId);
}

export function listDetachedRuns(): DetachedRun[] {
	return [...registry.values()];
}
