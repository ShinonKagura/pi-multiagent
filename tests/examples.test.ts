import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Compile } from "typebox/compile";
import { AgentTeamSchema } from "../extensions/multiagent/src/schemas.ts";
import { resolveDetachedGraph, validatePreflightShape } from "../extensions/multiagent/src/planning.ts";
import { discoverAgents, normalizeLibraryOptions } from "../extensions/multiagent/src/agents.ts";
import { BUILTIN_CHILD_TOOL_NAMES, type ParentSkillInventory, type ParentToolInfo, type ParentToolInventory } from "../extensions/multiagent/src/types.ts";

const validateAgentTeam = Compile(AgentTeamSchema);
const examplesDir = join(process.cwd(), "examples", "graphs");
const parentTools: ParentToolInventory = { apiAvailable: true, errorMessage: undefined, tools: activeBuiltinTools() };
const parentSkills: ParentSkillInventory = { apiAvailable: true, readActive: true, errorMessage: undefined, skills: [] };

function activeBuiltinTools(): ParentToolInfo[] {
	return BUILTIN_CHILD_TOOL_NAMES.map((name) => ({ name, description: `${name} tool`, sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level", baseDir: undefined }, active: true }));
}

test("graph cookbook examples are pure detached graph specs wrapped by start", async () => {
	const files = (await readdir(examplesDir)).filter((file) => file.endsWith(".json")).sort();
	assert.equal(files.length > 0, true);
	for (const file of files) {
		const raw = JSON.parse(await readFile(join(examplesDir, file), "utf8")) as Record<string, unknown>;
		assert.equal(raw.action, undefined, `${file} must be a pure graph, not an action wrapper`);
		assert.equal(raw.synthesis, undefined, `${file} must model synthesis as a normal step`);
		assert.equal(validateAgentTeam.Check({ action: "start", graph: raw }), true, `${file} must be start-schema valid`);
		const steps = raw.steps as { id: string; needs?: string[]; after?: string[]; agent: { ref?: string; system?: string } }[];
		assert.equal(steps.length > 0, true, `${file} must include steps`);
		assert.equal(new Set(steps.map((step) => step.id)).size, steps.length, `${file} duplicate step id`);
		for (const step of steps) {
			assert.equal(typeof step.agent.ref === "string" || typeof step.agent.system === "string", true, `${file}:${step.id} must bind an agent`);
			for (const need of step.needs ?? []) assert.equal(steps.some((candidate) => candidate.id === need), true, `${file}:${step.id} unknown dependency ${need}`);
			for (const after of step.after ?? []) assert.equal(steps.some((candidate) => candidate.id === after), true, `${file}:${step.id} unknown after dependency ${after}`);
		}
	}
});

test("graph examples keep tool grants explicit and minimal", async () => {
	const files = (await readdir(examplesDir)).filter((file) => file.endsWith(".json")).sort();
	for (const file of files) {
		const graph = await readGraphExample(file);
		if (file === "worktree-isolated-mutation.json") {
			// The one deliberately mutation-capable example demonstrates the v0.10 worktree-isolation
			// feature. It is exempt from the no-mutation rules below, but must keep that mutation
			// strictly isolated: worktree authority + a worktree-isolated worker step with a mutationScope.
			assert.equal(isRecord(graph.authority) && graph.authority.allowMutationWorktree === true, true, `${file} must set allowMutationWorktree for isolated mutation`);
			const mutateStep = graphSteps(graph).find((step) => isRecord(step.agent) && step.agent.ref === "package:worker");
			assert.equal(Boolean(mutateStep), true, `${file} should route its mutation through package:worker`);
			assert.equal(isRecord(mutateStep) && mutateStep.isolation === "worktree", true, `${file} mutation step must use isolation:'worktree'`);
			assert.equal(isRecord(mutateStep) && typeof mutateStep.mutationScope === "string" && mutateStep.mutationScope.length > 0, true, `${file} mutation step must declare a mutationScope`);
			continue;
		}
		assert.equal(isRecord(graph.authority) && graph.authority.allowMutationTools === true, false, `${file} should not be a mutation-capable packaged example`);
		for (const step of graphSteps(graph)) {
			const ref = isRecord(step.agent) && typeof step.agent.ref === "string" ? step.agent.ref : undefined;
			assert.notEqual(ref, "package:worker", `${file}:${String(step.id)} should not route packaged examples to package:worker`);
			if (!isRecord(step.agent) || !Array.isArray(step.agent.tools)) continue;
			const tools = step.agent.tools.filter((tool): tool is string => typeof tool === "string");
			assert.equal(tools.length === 0, false, `${file}:${String(step.id)} should omit tools instead of using tools:[] for read-only`);
			assert.equal(tools.every((tool) => ["read", "grep", "find", "ls"].includes(tool)), false, `${file}:${String(step.id)} should omit redundant read-only-only tools; explicit tools are for shell profiles`);
			assert.equal(tools.some((tool) => tool === "edit" || tool === "write"), false, `${file}:${String(step.id)} should not grant mutation tools`);
		}
	}
});

test("packaged graph examples resolve against bundled catalog with expected sinks", async () => {
	const discovery = discoverAgents({ cwd: process.cwd(), packageAgentsDir: join(process.cwd(), "agents"), library: normalizeLibraryOptions({ sources: ["package"] }) });
	// worktree-isolated-mutation.json is a copy/adapt TEMPLATE: its placeholder mutationScope is
	// intentionally denied at planning until replaced, so it cannot "resolve cleanly" as shipped. Its
	// structure + isolation safety are covered by the "tool grants explicit and minimal" test above,
	// so it is excluded from this runnable-resolve coverage check.
	const expectedSinks = new Map([
		["artifact-chained-decision.json", ["final-decision"]],
		["command-validation-only.json", ["final-proof"]],
		["completed-proof-review.json", ["final-decision"]],
		["cwd-launched-audit-fanout.json", ["audit-decision"]],
		["evidence-trace-audit.json", ["trace-decision"]],
		["human-gated-plan-only.json", ["final-decision"]],
		["inline-read-only-fanin.json", ["summary"]],
		["map-reduce-audit-fanout.json", ["reduce-decision"]],
		["model-facing-docs-audit.json", ["final-opportunities"]],
		["product-experience-source-audit.json", ["experience-decision"]],
		["read-only-audit-fanout.json", ["final-decision"]],
		["release-readiness-review.json", ["readiness-decision"]],
		["research-to-change-gated-loop.json", ["final-report"]],
		["sharded-map-reduce-audit.json", ["reduce-decision"]],
		["single-specialist-read-only.json", ["inspect"]],
		["tree-reduce-source-review.json", ["final-decision"]],
		["validation-matrix-gate.json", ["final-proof"]],
	]);
	const files = (await readdir(examplesDir)).filter((file) => file.endsWith(".json") && file !== "worktree-isolated-mutation.json").sort();
	assert.deepEqual(files, [...expectedSinks.keys()].sort(), "expected sink map must cover every packaged graph example exactly");
	for (const [file, sinks] of expectedSinks) {
		const graph = await readGraphExample(file);
		assert.deepEqual(sinkStepIds(graph), sinks, `${file} documented sink ids drifted`);
		const resolved = resolveDetachedGraph(graph as Parameters<typeof resolveDetachedGraph>[0], discovery.agents, [], { cwd: process.cwd(), invocationCwd: process.cwd(), parentTools, parentSkills }, undefined);
		assert.deepEqual(resolved.diagnostics.filter((item) => item.severity === "error"), [], `${file} should plan cleanly`);
		assert.equal(resolved.steps.length, ((graph.steps as unknown[]) ?? []).length, `${file} should resolve every step`);
	}
});

test("example graph roles match their positive choreography", async () => {
	const cwdFanout = await readGraphExample("cwd-launched-audit-fanout.json");
	assert.equal(findStep(cwdFanout, "extension-audit").cwd, "extensions/multiagent");
	assert.equal(findStep(cwdFanout, "skill-audit").cwd, "skills/pi-multiagent");
	assert.equal(findStep(cwdFanout, "examples-audit").cwd, "examples/graphs");
	assert.deepEqual(sinkStepIds(cwdFanout), ["audit-decision"]);

	const validation = await readGraphExample("command-validation-only.json");
	assert.equal(stepAgentRef(validation, "validation-proof"), "package:validator");
	assert.match(stepTask(validation, "validation-proof"), /git status -sb/);
	assert.match(stepTask(validation, "validation-proof"), /git diff --check/);

	const releaseReadiness = await readGraphExample("release-readiness-review.json");
	assert.equal(isRecord(releaseReadiness.authority) && releaseReadiness.authority.allowShellTools === true, true);
	assert.equal(stepAgentRef(releaseReadiness, "release-proof"), "package:validator");
	assert.deepEqual(stepAfter(releaseReadiness, "release-audit"), ["release-map", "release-proof"]);

	const chained = await readGraphExample("artifact-chained-decision.json");
	assert.match(stepTask(chained, "artifact-review"), /REPLACE_WITH_PRIOR_RUN_HANDLE_AND_ARTIFACT_PATHS/);
	assert.deepEqual(sinkStepIds(chained), ["final-decision"]);

	const productExperience = await readGraphExample("product-experience-source-audit.json");
	assert.equal(stepAgentRef(productExperience, "trust-recovery"), "package:critic");
	assert.match(stepTask(productExperience, "operator-loop"), /API\/headless/);
	assert.deepEqual(sinkStepIds(productExperience), ["experience-decision"]);

	const treeReduce = await readGraphExample("tree-reduce-source-review.json");
	assert.deepEqual(stepAfter(treeReduce, "reduce-source"), ["map-runtime", "map-docs"]);
	assert.deepEqual(stepAfter(treeReduce, "final-decision"), ["reduce-source", "reduce-proof"]);

	const evidenceTrace = await readGraphExample("evidence-trace-audit.json");
	assert.match(stepTask(evidenceTrace, "trace-decision"), /source-to-artifact-to-copy/);
	assert.deepEqual(sinkStepIds(evidenceTrace), ["trace-decision"]);
});

test("public Markdown agent_team JSON snippets are schema-valid", async () => {
	const files = ["README.md", "skills/pi-multiagent/SKILL.md", "skills/pi-multiagent/references/graph-cookbook.md"];
	let actionSnippets = 0;
	let graphSnippets = 0;
	for (const file of files) {
		const markdown = await readFile(join(process.cwd(), file), "utf8");
		for (const [index, block] of jsonBlocks(markdown).entries()) {
			const parsed = JSON.parse(block) as unknown;
			if (!isRecord(parsed)) continue;
			if ("action" in parsed) {
				actionSnippets += 1;
				assert.equal(validateAgentTeam.Check(parsed), true, `${file} JSON block ${index + 1} must match AgentTeamSchema`);
				assert.deepEqual(validatePreflightShape(parsed as Parameters<typeof validatePreflightShape>[0]).filter((item) => item.severity === "error"), [], `${file} JSON block ${index + 1} must pass action preflight`);
			} else if ("objective" in parsed && "steps" in parsed) {
				graphSnippets += 1;
				assert.equal(validateAgentTeam.Check({ action: "start", graph: parsed }), true, `${file} JSON block ${index + 1} must be a start graph`);
			}
		}
	}
	assert.equal(actionSnippets > 0, true, "Markdown docs must contain validated action snippets");
	assert.equal(graphSnippets > 0, true, "Markdown docs must contain validated pure graph snippets");
});

async function readGraphExample(file: string): Promise<Record<string, unknown>> {
	const parsed: unknown = JSON.parse(await readFile(join(examplesDir, file), "utf8"));
	if (!isRecord(parsed)) throw new Error(`${file} must parse to an object`);
	return parsed;
}

function graphSteps(graph: Record<string, unknown>): Record<string, unknown>[] {
	const steps = graph.steps;
	if (!Array.isArray(steps)) throw new Error("graph must contain steps");
	return steps.filter((step): step is Record<string, unknown> => isRecord(step));
}

function sinkStepIds(graph: Record<string, unknown>): string[] {
	const steps = graph.steps;
	if (!Array.isArray(steps)) throw new Error("graph must contain steps");
	const dependedOn = new Set<string>();
	for (const step of steps) {
		if (!isRecord(step)) continue;
		for (const key of ["needs", "after"]) {
			const ids = step[key];
			if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") dependedOn.add(id);
		}
	}
	return steps.filter((step): step is Record<string, unknown> => isRecord(step) && typeof step.id === "string" && !dependedOn.has(step.id)).map((step) => step.id as string);
}

function stepTask(graph: Record<string, unknown>, id: string): string {
	const step = findStep(graph, id);
	if (typeof step.task !== "string") throw new Error(`step ${id} must have a task`);
	return step.task;
}

function stepAgentRef(graph: Record<string, unknown>, id: string): string {
	const step = findStep(graph, id);
	if (!isRecord(step.agent) || typeof step.agent.ref !== "string") throw new Error(`step ${id} must have agent.ref`);
	return step.agent.ref;
}

function stepAfter(graph: Record<string, unknown>, id: string): string[] {
	const step = findStep(graph, id);
	if (!Array.isArray(step.after)) return [];
	return step.after.filter((after): after is string => typeof after === "string");
}

function findStep(graph: Record<string, unknown>, id: string): Record<string, unknown> {
	const steps = graph.steps;
	if (!Array.isArray(steps)) throw new Error("graph must contain steps");
	const step = steps.find((candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.id === id);
	if (!step) throw new Error(`missing step ${id}`);
	return step;
}

function jsonBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	const pattern = /```json\n([\s\S]*?)```/g;
	let match = pattern.exec(markdown);
	while (match) {
		blocks.push(match[1].trim());
		match = pattern.exec(markdown);
	}
	return blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
