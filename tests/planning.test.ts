import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentConfig, ParentSkillInventory, ParentToolInfo, ParentToolInventory } from "../extensions/multiagent/src/types.ts";
import { resolveDetachedGraph, validatePreflightShape } from "../extensions/multiagent/src/planning.ts";
import { findProjectSettingsFile } from "../extensions/multiagent/src/project-settings.ts";
import { readSubagentSkillConfig } from "../extensions/multiagent/src/subagent-skills-config.ts";
import { BUILTIN_CHILD_TOOL_NAMES, MAX_CALLER_SKILLS, READONLY_CHILD_TOOL_NAMES } from "../extensions/multiagent/src/types.ts";

const parentTools: ParentToolInventory = { apiAvailable: true, errorMessage: undefined, tools: activeBuiltinTools() };
const parentSkills: ParentSkillInventory = { apiAvailable: true, readActive: true, errorMessage: undefined, skills: [] };

function activeBuiltinTools(): ParentToolInfo[] {
	return BUILTIN_CHILD_TOOL_NAMES.map((name) => ({ name, description: `${name} tool`, sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level", baseDir: undefined }, active: true }));
}

function packageAgent(name = "reviewer", tools: string[] | undefined = ["read"]): AgentConfig {
	return { name, ref: `package:${name}`, description: `${name} agent`, tags: [], tools, model: undefined, thinking: undefined, systemPrompt: "Review.", source: "package", filePath: `/tmp/${name}.md`, sha256: "abc" };
}

function userAgent(name = "reviewer", tools: string[] | undefined = ["read"]): AgentConfig {
	return { name, ref: `user:${name}`, description: `${name} agent`, tags: [], tools, model: undefined, thinking: undefined, systemPrompt: "Review.", source: "user", filePath: `/tmp/${name}.md`, sha256: "abc" };
}

function graphInput(): object {
	return { objective: "x", steps: [{ id: "one", agent: { system: "x" }, task: "x" }] };
}

test("validatePreflightShape enforces detached action fields", () => {
	assert.deepEqual(validatePreflightShape({ action: "start", graph: { objective: "x", steps: [] } }).map((item) => item.code), []);
	assert.equal(validatePreflightShape({ action: "run" }).some((item) => item.code === "action-invalid"), true);
	const catalogMaxBytes = validatePreflightShape({ action: "catalog", maxBytes: 100 });
	assert.equal(catalogMaxBytes.some((item) => item.code === "catalog-control-fields-denied"), true);
	assert.deepEqual(catalogMaxBytes.find((item) => item.code === "catalog-control-fields-denied")?.fields, ["maxBytes"]);
	assert.match(catalogMaxBytes.find((item) => item.code === "catalog-control-fields-denied")?.repair ?? "", /library\.query/);
	assert.equal(validatePreflightShape({ action: "catalog", graph: {} }).some((item) => item.code === "catalog-control-fields-denied"), true);
	const oldStartShape = validatePreflightShape({ action: "start", objective: "old", steps: [] });
	assert.equal(oldStartShape.some((item) => item.code === "start-control-fields-denied"), true);
	assert.match(oldStartShape.find((item) => item.code === "start-control-fields-denied")?.repair ?? "", /under graph/);
	const oldStartWithPreview = validatePreflightShape({ action: "start", objective: "old", steps: [], preview: true });
	assert.match(oldStartWithPreview.find((item) => item.code === "start-control-fields-denied")?.repair ?? "", /Move graph body fields under graph/);
	const topLevelAuthority = validatePreflightShape({ action: "start", objective: "old", authority: { allowFilesystemRead: true }, steps: [] });
	assert.deepEqual(topLevelAuthority.find((item) => item.code === "start-control-fields-denied")?.fields, ["objective", "steps", "authority"]);
	assert.match(topLevelAuthority.find((item) => item.code === "start-control-fields-denied")?.repair ?? "", /authority/);
	const topLevelExtensionTools = validatePreflightShape({ action: "start", graph: graphInput(), extensionTools: [] });
	assert.match(topLevelExtensionTools.find((item) => item.code === "start-control-fields-denied")?.repair ?? "", /steps\[\]\.agent\.extensionTools/);
	assert.equal(validatePreflightShape({ action: "start", graph: graphInput(), cursor: "1" }).some((item) => item.code === "start-control-fields-denied"), true);
	assert.equal(validatePreflightShape({ action: "run_status", runId: "r1", graph: graphInput() }).some((item) => item.code === "run_status-control-fields-denied"), true);
	assert.equal(validatePreflightShape({ action: "cancel", runId: "r1", maxBytes: 1 }).some((item) => item.code === "cancel-control-fields-denied"), true);
	assert.equal(validatePreflightShape({ action: "cleanup", runId: "r1", reason: "x" }).some((item) => item.code === "cleanup-control-fields-denied"), true);
	assert.equal(validatePreflightShape({ action: "run_status", runId: "r1", debugEvents: true }).length, 0);
	assert.equal(validatePreflightShape({ action: "run_status", runId: "r1", stepId: "one", waitSeconds: 1 }).length, 0);
	const missingStepResultStep = validatePreflightShape({ action: "step_result", runId: "r1" });
	assert.equal(missingStepResultStep.some((item) => item.code === "step_result-step-required"), true);
	assert.match(missingStepResultStep.find((item) => item.code === "step_result-step-required")?.repair ?? "", /one concrete step id/);
	assert.match(missingStepResultStep.find((item) => item.code === "step_result-step-required")?.repair ?? "", /run_status for run-level/);
	assert.equal(validatePreflightShape({ action: "step_result", runId: "r1", stepId: "one", maxBytes: 100 }).length, 0);
	const stepDebug = validatePreflightShape({ action: "step_result", runId: "r1", stepId: "one", debugEvents: true });
	assert.equal(stepDebug.some((item) => item.code === "step_result-control-fields-denied"), true);
	assert.match(stepDebug.find((item) => item.code === "step_result-control-fields-denied")?.repair ?? "", /run_status/);
	assert.match(stepDebug.find((item) => item.code === "step_result-control-fields-denied")?.repair ?? "", /maxBytes/);
	assert.equal(validatePreflightShape({ action: "message", runId: "r1", text: "x", channel: "steer" }).some((item) => item.code === "message-step-required"), true);
	const staleKind = validatePreflightShape({ action: "message", runId: "r1", text: "x", stepId: "one", kind: "steer" });
	assert.equal(staleKind.some((item) => item.code === "message-control-fields-denied"), true);
	assert.equal(staleKind.some((item) => item.code === "message-channel-required"), true);
	assert.equal(validatePreflightShape({ action: "step_result", runId: "r1", stepId: "one", waitSeconds: 1 }).some((item) => item.code === "step_result-control-fields-denied"), true);
});

test("resolveDetachedGraph rejects blank-after-trim graph objective and inline system prompts", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-blank-${Date.now()}`), { recursive: true });
	const blank = resolveDetachedGraph({ objective: "   \n\t", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { system: "  \n" }, task: "x" }] }, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills }, undefined);
	assert.equal(blank.diagnostics.some((item) => item.code === "graph-objective-required" && item.path === "/graph/objective"), true);
	assert.equal(blank.diagnostics.some((item) => item.code === "inline-system-required" && item.path === "/graph/steps/0/agent/system"), true);
	assert.deepEqual(blank.steps, []);
});

test("resolveDetachedGraph rejects missing or mixed step agent binding", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-agent-binding-${Date.now()}`), { recursive: true });
	const missing = resolveDetachedGraph({ objective: "missing", steps: [{ id: "one", agent: {}, task: "x" }] }, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills }, undefined);
	assert.equal(missing.diagnostics.some((item) => item.code === "step-agent-invalid"), true);
	assert.deepEqual(missing.steps, []);
	const mixed = resolveDetachedGraph({ objective: "mixed", steps: [{ id: "one", agent: { system: "x", ref: "package:reviewer" }, task: "x" }] }, [packageAgent()], [], { cwd, invocationCwd: cwd, parentTools, parentSkills }, undefined);
	assert.equal(mixed.diagnostics.some((item) => item.code === "step-agent-binding-exclusive"), true);
	assert.deepEqual(mixed.steps, []);
});

test("resolveDetachedGraph inherits library defaults and caps them by authority", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-${Date.now()}`), { recursive: true });
	const graph = resolveDetachedGraph(
		{
			objective: "plan",
			authority: { allowFilesystemRead: true },
			steps: [
				{ id: "inspect", agent: { ref: "package:reviewer" }, task: "Inspect." },
				{ id: "summarize", agent: { system: "Summarize." }, task: "Summarize.", needs: ["inspect"] },
			],
			limits: { concurrency: 1, timeoutSecondsPerStep: 10 },
		},
		[packageAgent("reviewer", ["read", "bash"])],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(graph.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(graph.steps.map((step) => step.id), ["inspect", "summarize"]);
	assert.equal(graph.steps[0].agent.ref, "package:reviewer");
	assert.deepEqual(graph.steps[1].after, []);
	assert.deepEqual(graph.steps[0].agent.tools, READONLY_CHILD_TOOL_NAMES);
	assert.equal(graph.diagnostics.some((item) => item.code === "catalog-default-tools-capped" && item.severity === "warning" && item.message.includes("denied=bash")), true);
	assert.deepEqual(graph.steps[1].agent.tools, READONLY_CHILD_TOOL_NAMES);
	assert.equal(graph.limits.concurrency, 1);
});

test("resolveDetachedGraph rejects inherited catalog defaults capped to no tools", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-capped-${Date.now()}`), { recursive: true });
	const graph = resolveDetachedGraph(
		{ objective: "capped", steps: [{ id: "one", agent: { ref: "package:reviewer" }, task: "x" }] },
		[packageAgent("reviewer", ["read"])],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(graph.diagnostics.some((item) => item.code === "catalog-default-tools-denied" && item.severity === "error"), true);
	assert.deepEqual(graph.steps, []);

	const explicitEmptyTools = resolveDetachedGraph(
		{ objective: "explicit empty tools", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "package:reviewer", tools: [] }, task: "x" }] },
		[packageAgent("reviewer", ["read"])],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(explicitEmptyTools.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(explicitEmptyTools.steps[0]?.agent.tools, READONLY_CHILD_TOOL_NAMES);
});

test("resolveDetachedGraph reports inline missing read authority without catalog-default wording", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-inline-no-read-${Date.now()}`), { recursive: true });
	for (const agent of [{ system: "x" }, { system: "x", tools: [] }, { system: "x", tools: ["read"] }]) {
		const graph = resolveDetachedGraph(
			{ objective: "inline no read", steps: [{ id: "one", agent, task: "x" }] },
			[],
			[],
			{ cwd, invocationCwd: cwd, parentTools, parentSkills },
			undefined,
		);
		assert.equal(graph.diagnostics.some((item) => item.code === "filesystem-read-authority-required"), true);
		assert.equal(graph.diagnostics.some((item) => item.code === "catalog-default-tools-denied"), false);
		assert.deepEqual(graph.steps, []);
	}
});

test("findProjectSettingsFile ignores the user-global Pi settings file", async () => {
	const home = await mkdir(join(tmpdir(), `pi-multiagent-plan-global-pi-${Date.now()}`), { recursive: true });
	const globalPi = join(home, ".pi");
	const project = join(home, "Code", "repo");
	await mkdir(globalPi, { recursive: true });
	await mkdir(project, { recursive: true });
	await writeFile(join(globalPi, "settings.json"), "{}");
	assert.equal(findProjectSettingsFile(project, globalPi), undefined);
	await mkdir(join(project, ".pi"), { recursive: true });
	await writeFile(join(project, ".pi", "settings.json"), "{}");
	assert.equal(findProjectSettingsFile(project, globalPi), join(project, ".pi", "settings.json"));
});

test("resolveDetachedGraph refuses bash steps inside project Pi settings at planning time", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-bash-settings-${Date.now()}`), { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi", "settings.json"), "{}");
	const denied = resolveDetachedGraph(
		{ objective: "settings", authority: { allowFilesystemRead: true, allowShellTools: true }, steps: [{ id: "one", agent: { system: "x", tools: ["bash"] }, task: "x" }] },
		[],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(denied.diagnostics.some((item) => item.code === "bash-project-settings-denied"), true);
	assert.deepEqual(denied.steps, []);
	const readOnly = resolveDetachedGraph(
		{ objective: "settings", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { system: "x", tools: ["read"] }, task: "x" }] },
		[],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(readOnly.diagnostics.some((item) => item.severity === "error"), false);
});

test("resolveDetachedGraph rejects inherited shell defaults when mandatory read is not authorized", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-shell-no-read-${Date.now()}`), { recursive: true });
	const graph = resolveDetachedGraph(
		{ objective: "shell", authority: { allowShellTools: true }, steps: [{ id: "one", agent: { ref: "package:reviewer" }, task: "x" }] },
		[packageAgent("reviewer", ["read", "bash"])],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(graph.diagnostics.some((item) => item.code === "filesystem-read-authority-required"), true);
	assert.deepEqual(graph.steps, []);
});

test("resolveDetachedGraph grants inherited shell defaults only when shell authority is set", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-shell-${Date.now()}`), { recursive: true });
	const graph = resolveDetachedGraph(
		{ objective: "shell", authority: { allowFilesystemRead: true, allowShellTools: true }, steps: [{ id: "one", agent: { ref: "package:reviewer" }, task: "Run `git status -sb`." }] },
		[packageAgent("reviewer", ["read", "bash"])],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(graph.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(graph.steps[0]?.agent.tools, [...READONLY_CHILD_TOOL_NAMES, "bash"]);
});

test("resolveDetachedGraph treats explicit tools as strict overrides", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-explicit-${Date.now()}`), { recursive: true });
	const allowed = resolveDetachedGraph(
		{ objective: "explicit", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "package:reviewer", tools: ["read"] }, task: "x" }] },
		[packageAgent("reviewer", ["read", "bash"])],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.deepEqual(allowed.steps[0]?.agent.tools, READONLY_CHILD_TOOL_NAMES);
	const denied = resolveDetachedGraph(
		{ objective: "explicit", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "package:reviewer", tools: ["bash", "edit"] }, task: "x" }] },
		[packageAgent("reviewer", ["read", "bash"])],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	const codes = denied.diagnostics.map((item) => item.code);
	assert.equal(codes.includes("shell-authority-required"), true);
	assert.equal(codes.includes("mutation-authority-required"), true);
	assert.deepEqual(denied.steps, []);
});

test("resolveDetachedGraph caps package:validator default tools to granted authority (no hard shell requirement)", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-validator-tools-${Date.now()}`), { recursive: true });
	const validator = packageAgent("validator", ["read", "bash"]);
	const allowed = resolveDetachedGraph(
		{ objective: "validator", authority: { allowFilesystemRead: true, allowShellTools: true }, steps: [{ id: "one", agent: { ref: "package:validator" }, task: "Run `git diff --check`." }] },
		[validator],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(allowed.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(allowed.steps[0]?.agent.tools, [...READONLY_CHILD_TOOL_NAMES, "bash"]);
	const cappedDefault = resolveDetachedGraph(
		{ objective: "validator", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "package:validator" }, task: "Run `git diff --check`." }] },
		[validator],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	// No shell authority: bash is capped out of the default tool set with a warning; the step still runs read-only.
	assert.equal(cappedDefault.diagnostics.some((item) => item.severity === "error"), false);
	assert.equal(cappedDefault.diagnostics.some((item) => item.code === "catalog-default-tools-capped"), true);
	assert.deepEqual(cappedDefault.steps[0]?.agent.tools, [...READONLY_CHILD_TOOL_NAMES]);
	const explicitReadOnly = resolveDetachedGraph(
		{ objective: "validator", authority: { allowFilesystemRead: true, allowShellTools: true }, steps: [{ id: "one", agent: { ref: "package:validator", tools: ["read"] }, task: "Review only." }] },
		[validator],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	// Explicit read-only tools are honored without error (no hard validator-shell requirement).
	assert.equal(explicitReadOnly.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(explicitReadOnly.steps[0]?.agent.tools, [...READONLY_CHILD_TOOL_NAMES]);
});

test("resolveDetachedGraph requires a mutationScope for mutation-capable steps (package:worker and inline edit/write)", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-worker-tools-${Date.now()}`), { recursive: true });
	const worker = packageAgent("worker", ["read", "bash", "edit", "write"]);
	const allowed = resolveDetachedGraph(
		{ objective: "worker", authority: { allowFilesystemRead: true, allowShellTools: true, allowMutationTools: true }, steps: [{ id: "one", agent: { ref: "package:worker" }, task: "Implement the delegated change.", mutationScope: "edit under src/, no deletes" }] },
		[worker],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(allowed.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(allowed.steps[0]?.agent.tools, [...READONLY_CHILD_TOOL_NAMES, "bash", "edit", "write"]);
	const shellOnlyWorker = resolveDetachedGraph(
		{ objective: "worker", authority: { allowFilesystemRead: true, allowShellTools: true }, steps: [{ id: "one", agent: { ref: "package:worker", tools: ["bash"] }, task: "Run the validation command." }] },
		[worker],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	// package:worker is a mutation-capable role, so it requires an explicit mutationScope even when capped to bash.
	assert.equal(shellOnlyWorker.diagnostics.some((item) => item.code === "mutation-scope-required"), true);
	assert.deepEqual(shellOnlyWorker.steps, []);
	const inlineWrite = resolveDetachedGraph(
		{ objective: "inline", authority: { allowFilesystemRead: true, allowMutationTools: true }, steps: [{ id: "one", agent: { system: "x", tools: ["edit"] }, task: "Edit.", mutationScope: "edit under src/" }] },
		[],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(inlineWrite.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(inlineWrite.steps[0]?.agent.tools, [...READONLY_CHILD_TOOL_NAMES, "edit"]);
	const readOnlyWorker = resolveDetachedGraph(
		{ objective: "worker", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "package:worker", tools: ["read"] }, task: "Plan only." }] },
		[worker],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	// A worker explicitly capped to read-only is not a mutation step, so no mutationScope is required.
	assert.equal(readOnlyWorker.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(readOnlyWorker.steps[0]?.agent.tools, [...READONLY_CHILD_TOOL_NAMES]);
});

test("resolveDetachedGraph grants source-verified extension tools only with extension authority", async () => {
	const parent = await mkdir(join(tmpdir(), `pi-multiagent-plan-extension-${Date.now()}`), { recursive: true });
	const cwd = await mkdir(join(parent, "workspace"), { recursive: true });
	const extensionPath = join(parent, "trusted-extension.ts");
	await writeFile(extensionPath, "export default function extension() {}\n");
	const extensionTool: ParentToolInfo = { name: "exa_search", description: "Search", active: true, sourceInfo: { path: extensionPath, source: "user:exa", scope: "user", origin: "package", baseDir: parent } };
	const tools: ParentToolInventory = { apiAvailable: true, errorMessage: undefined, tools: [...activeBuiltinTools(), extensionTool] };
	const graph = { objective: "extension", authority: { allowFilesystemRead: true, allowExtensionCode: true }, steps: [{ id: "one", agent: { system: "x", extensionTools: [{ name: "exa_search", from: { source: "user:exa", scope: "user", origin: "package" } }] }, task: "x" }] };
	const allowed = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools: tools, parentSkills }, undefined);
	assert.equal(allowed.diagnostics.some((item) => item.severity === "error"), false);
	assert.equal(allowed.steps[0]?.agent.extensionTools[0]?.name, "exa_search");
	assert.equal(allowed.steps[0]?.agent.extensionTools[0]?.source.realpath, await realpath(extensionPath));
	assert.deepEqual(allowed.steps[0]?.agent.tools, READONLY_CHILD_TOOL_NAMES);
	const denied = resolveDetachedGraph({ ...graph, authority: {} }, [], [], { cwd, invocationCwd: cwd, parentTools: tools, parentSkills }, undefined);
	assert.equal(denied.diagnostics.some((item) => item.code === "extension-code-authority-required"), true);
	assert.deepEqual(denied.steps, []);
});

test("resolveDetachedGraph fails package:web-researcher closed without callable web search and fetch grants", async () => {
	const parent = await mkdir(join(tmpdir(), `pi-multiagent-plan-web-researcher-${Date.now()}`), { recursive: true });
	const cwd = await mkdir(join(parent, "workspace"), { recursive: true });
	const extensionPath = join(parent, "web-extension.ts");
	const otherExtensionPath = join(parent, "other-extension.ts");
	await writeFile(extensionPath, "export default function extension() {}\n");
	await writeFile(otherExtensionPath, "export default function extension() {}\n");
	const searchTool: ParentToolInfo = { name: "exa_search", description: "Search the web", active: true, sourceInfo: { path: extensionPath, source: "user:exa", scope: "user", origin: "package", baseDir: parent } };
	const fetchTool: ParentToolInfo = { name: "exa_fetch", description: "Fetch a URL", active: true, sourceInfo: { path: extensionPath, source: "user:exa", scope: "user", origin: "package", baseDir: parent } };
	const otherTool: ParentToolInfo = { name: "jira_read", description: "Read Jira", active: true, sourceInfo: { path: otherExtensionPath, source: "user:jira", scope: "user", origin: "package", baseDir: parent } };
	const tools: ParentToolInventory = { apiAvailable: true, errorMessage: undefined, tools: [...activeBuiltinTools(), searchTool, fetchTool, otherTool] };
	const webAgent = packageAgent("web-researcher", ["read"]);
	const baseStep = { id: "web", agent: { ref: "package:web-researcher" }, task: "Research current docs." };
	const noGrants = resolveDetachedGraph({ objective: "web", authority: { allowFilesystemRead: true }, steps: [baseStep] }, [webAgent], [], { cwd, invocationCwd: cwd, parentTools: tools, parentSkills }, undefined);
	assert.equal(noGrants.diagnostics.some((item) => item.code === "web-researcher-extension-tools-required"), true);
	assert.deepEqual(noGrants.steps, []);

	const extensionTools = [{ name: "exa_search", from: { source: "user:exa", scope: "user", origin: "package" } }, { name: "exa_fetch", from: { source: "user:exa", scope: "user", origin: "package" } }];
	const missingAuthority = resolveDetachedGraph({ objective: "web", authority: { allowFilesystemRead: true }, steps: [{ ...baseStep, agent: { ref: "package:web-researcher", extensionTools } }] }, [webAgent], [], { cwd, invocationCwd: cwd, parentTools: tools, parentSkills }, undefined);
	assert.equal(missingAuthority.diagnostics.some((item) => item.code === "extension-code-authority-required"), true);
	assert.deepEqual(missingAuthority.steps, []);

	const nonWebGrant = resolveDetachedGraph({ objective: "web", authority: { allowFilesystemRead: true, allowExtensionCode: true }, steps: [{ ...baseStep, agent: { ref: "package:web-researcher", extensionTools: [{ name: "jira_read", from: { source: "user:jira", scope: "user", origin: "package" } }] } }] }, [webAgent], [], { cwd, invocationCwd: cwd, parentTools: tools, parentSkills }, undefined);
	assert.equal(nonWebGrant.diagnostics.some((item) => item.code === "web-researcher-extension-tools-required"), true);
	assert.deepEqual(nonWebGrant.steps, []);

	const allowed = resolveDetachedGraph({ objective: "web", authority: { allowFilesystemRead: true, allowExtensionCode: true }, steps: [{ ...baseStep, agent: { ref: "package:web-researcher", extensionTools } }] }, [webAgent], [], { cwd, invocationCwd: cwd, parentTools: tools, parentSkills }, undefined);
	assert.equal(allowed.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(allowed.steps[0]?.agent.extensionTools.map((tool) => tool.name), ["exa_search", "exa_fetch"]);
	assert.equal(allowed.steps[0]?.agent.extensionTools[0]?.source.realpath, await realpath(extensionPath));
	assert.deepEqual(allowed.steps[0]?.agent.tools, READONLY_CHILD_TOOL_NAMES);
});

test("resolveDetachedGraph propagates project and workspace-local caller skills by default", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-skills-${Date.now()}`), { recursive: true });
	const skillPath = join(cwd, "project-skill.md");
	const userLink = join(cwd, "user-link.md");
	await writeFile(skillPath, "# Project skill\n");
	await symlink(skillPath, userLink);
	const projectSkills: ParentSkillInventory = {
		apiAvailable: true,
		readActive: true,
		errorMessage: undefined,
		skills: [
			{
				name: "project-skill",
				description: "Project skill",
				sourceInfo: { path: skillPath, source: "project:project-skill", scope: "project", origin: "top-level", baseDir: cwd },
			},
			{
				name: "user-link",
				description: "User skill symlinked into workspace",
				sourceInfo: { path: userLink, source: "user:user-link", scope: "user", origin: "top-level", baseDir: dirname(cwd) },
			},
		],
	};
	const graph = {
		objective: "skills",
		authority: { allowFilesystemRead: true },
		steps: [{ id: "one", agent: { system: "x", tools: ["read"] }, task: "x" }],
	};
	const resolved = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: projectSkills }, undefined);
	assert.equal(resolved.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(resolved.steps[0]?.agent.callerSkills.map((skill) => skill.name), ["project-skill", "user-link"]);

	const repoRoot = await mkdir(join(tmpdir(), `pi-multiagent-plan-skills-repo-root-${Date.now()}`), { recursive: true });
	await mkdir(join(repoRoot, ".git"));
	const subdir = join(repoRoot, "src");
	await mkdir(subdir);
	const repoSkillPath = join(repoRoot, "repo-skill.md");
	await writeFile(repoSkillPath, "# Repo skill\n");
	const repoSkills: ParentSkillInventory = {
		apiAvailable: true,
		readActive: true,
		errorMessage: undefined,
		skills: [
			{
				name: "repo-skill",
				description: "Repo skill reported as user-scoped",
				sourceInfo: { path: repoSkillPath, source: "user:repo-skill", scope: "user", origin: "top-level", baseDir: dirname(repoRoot) },
			},
		],
	};
	const subdirGraph = { objective: "subdir skills", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { system: "x", tools: ["read"] }, task: "x" }] };
	const subdirResolved = resolveDetachedGraph(subdirGraph, [], [], { cwd: subdir, invocationCwd: subdir, parentTools, parentSkills: repoSkills }, undefined);
	assert.equal(subdirResolved.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(subdirResolved.steps[0]?.agent.callerSkills.map((skill) => skill.name), ["repo-skill"]);
});

test("resolveDetachedGraph propagates all caller skills by default and none when product config disables them", async () => {
	const parent = await mkdir(join(tmpdir(), `pi-multiagent-plan-skills-default-${Date.now()}`), { recursive: true });
	const cwd = await mkdir(join(parent, "workspace"), { recursive: true });
	const skillPath = join(parent, "visible-skill.md");
	await writeFile(skillPath, "# Visible skill\n");
	const visibleSkills: ParentSkillInventory = {
		apiAvailable: true,
		readActive: true,
		errorMessage: undefined,
		skills: [
			{
				name: "visible-skill",
				description: "Visible skill",
				sourceInfo: { path: skillPath, source: "user:visible-skill", scope: "user", origin: "top-level", baseDir: parent },
			},
		],
	};
	const graph = { objective: "skills default", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { system: "x", tools: ["read"] }, task: "x" }] };
	const enabled = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: visibleSkills }, undefined);
	assert.equal(enabled.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(enabled.steps[0]?.agent.callerSkills.map((skill) => skill.name), ["visible-skill"]);
	const explicitEnabled = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: visibleSkills, subagentSkillMode: "enabled" }, undefined);
	assert.deepEqual(explicitEnabled.steps[0]?.agent.callerSkills.map((skill) => skill.name), ["visible-skill"]);
	const disabled = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: visibleSkills, subagentSkillMode: "disabled" }, undefined);
	assert.equal(disabled.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(disabled.steps[0]?.agent.callerSkills, []);
	const unavailable = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: { apiAvailable: false, readActive: false, errorMessage: "inventory failed", skills: [] } }, undefined);
	assert.equal(unavailable.diagnostics.some((item) => item.code === "subagent-skills-inventory-unavailable"), true);
	assert.deepEqual(unavailable.steps, []);
	const readInactive = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: { apiAvailable: true, readActive: false, errorMessage: undefined, skills: [] } }, undefined);
	assert.equal(readInactive.diagnostics.some((item) => item.code === "subagent-skills-parent-read-inactive"), true);
	assert.deepEqual(readInactive.steps, []);
});

test("resolveDetachedGraph auto mode soft-caps over-limit caller skills to none with a warning, while enabled hard-fails", async () => {
	const parent = await mkdir(join(tmpdir(), `pi-multiagent-plan-skills-overflow-${Date.now()}`), { recursive: true });
	const cwd = await mkdir(join(parent, "workspace"), { recursive: true });
	const overflow = MAX_CALLER_SKILLS + 1;
	const skills: ParentSkillInventory["skills"] = [];
	for (let index = 0; index < overflow; index += 1) {
		const name = `overflow-skill-${index}`;
		const skillPath = join(parent, `${name}.md`);
		await writeFile(skillPath, `# ${name}\n`);
		skills.push({ name, description: name, sourceInfo: { path: skillPath, source: `user:${name}`, scope: "user", origin: "top-level", baseDir: parent } });
	}
	const overflowSkills: ParentSkillInventory = { apiAvailable: true, readActive: true, errorMessage: undefined, skills };
	const graph = { objective: "skills overflow", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { system: "x", tools: ["read"] }, task: "x" }] };

	const auto = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: overflowSkills, subagentSkillMode: "auto" }, undefined);
	assert.equal(auto.diagnostics.some((item) => item.severity === "error"), false);
	assert.equal(auto.diagnostics.some((item) => item.code === "subagent-skills-overflow-dropped" && item.severity === "warning"), true);
	assert.deepEqual(auto.steps[0]?.agent.callerSkills, []);

	const enabled = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: overflowSkills, subagentSkillMode: "enabled" }, undefined);
	assert.equal(enabled.diagnostics.some((item) => item.code === "subagent-skills-too-many" && item.severity === "error"), true);
	assert.deepEqual(enabled.steps, []);
});

test("resolveDetachedGraph fails all-or-nothing when any enabled caller skill source is unavailable", async () => {
	const parent = await mkdir(join(tmpdir(), `pi-multiagent-plan-skills-unavailable-${Date.now()}`), { recursive: true });
	const cwd = await mkdir(join(parent, "workspace"), { recursive: true });
	const validSkillPath = join(parent, "valid-skill.md");
	await writeFile(validSkillPath, "# Valid skill\n");
	const skills: ParentSkillInventory = { apiAvailable: true, readActive: true, errorMessage: undefined, skills: [
		{ name: "valid-skill", description: "Valid", sourceInfo: { path: validSkillPath, source: "user:valid-skill", scope: "user", origin: "top-level", baseDir: parent } },
		{ name: "missing-skill", description: "Missing", sourceInfo: { path: join(parent, "missing-skill.md"), source: "user:missing-skill", scope: "user", origin: "top-level", baseDir: parent } },
	] };
	const graph = { objective: "skills unavailable", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { system: "x", tools: ["read"] }, task: "x" }] };
	const result = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills: skills }, undefined);
	assert.equal(result.diagnostics.some((item) => item.code === "caller-skill-source-unavailable" && item.severity === "error"), true);
	assert.deepEqual(result.steps, []);
});

test("readSubagentSkillConfig defaults enabled and rejects invalid values", () => {
	assert.deepEqual(readSubagentSkillConfig(undefined), { config: { mode: "enabled" }, diagnostics: [] });
	assert.deepEqual(readSubagentSkillConfig("disabled"), { config: { mode: "disabled" }, diagnostics: [] });
	const invalid = readSubagentSkillConfig("sometimes");
	assert.deepEqual(invalid.config, { mode: "enabled" });
	assert.equal(invalid.diagnostics[0]?.code, "subagent-skills-config-invalid");
});

test("resolveDetachedGraph accepts project and local extension sources with explicit extension authority", async () => {
	const parent = await mkdir(join(tmpdir(), `pi-multiagent-plan-extension-project-${Date.now()}`), { recursive: true });
	const cwd = await mkdir(join(parent, "workspace"), { recursive: true });
	const projectPath = join(parent, "project-extension.ts");
	const localPath = join(parent, "local-extension.ts");
	await writeFile(projectPath, "export default function extension() {}\n");
	await writeFile(localPath, "export default function extension() {}\n");
	const projectTool: ParentToolInfo = { name: "project_search", description: "Project search", active: true, sourceInfo: { path: projectPath, source: "project:search", scope: "project", origin: "top-level", baseDir: parent } };
	const localTool: ParentToolInfo = { name: "local_search", description: "Local search", active: true, sourceInfo: { path: localPath, source: "user:local", scope: "temporary", origin: "top-level", baseDir: parent } };
	const tools: ParentToolInventory = { apiAvailable: true, errorMessage: undefined, tools: [...activeBuiltinTools(), projectTool, localTool] };

	const projectGraph = { objective: "project extension", authority: { allowFilesystemRead: true, allowExtensionCode: true }, steps: [{ id: "one", agent: { system: "x", extensionTools: [{ name: "project_search", from: { source: "project:search", scope: "project", origin: "top-level" } }] }, task: "x" }] };
	const projectAllowed = resolveDetachedGraph(projectGraph, [], [], { cwd, invocationCwd: cwd, parentTools: tools, parentSkills }, undefined);
	assert.equal(projectAllowed.diagnostics.some((item) => item.severity === "error"), false);
	assert.equal(projectAllowed.steps[0]?.agent.extensionTools[0]?.name, "project_search");

	const localGraph = { objective: "local extension", authority: { allowFilesystemRead: true, allowExtensionCode: true }, steps: [{ id: "one", agent: { system: "x", extensionTools: [{ name: "local_search", from: { source: "user:local", scope: "temporary", origin: "top-level" } }] }, task: "x" }] };
	const localAllowed = resolveDetachedGraph(localGraph, [], [], { cwd, invocationCwd: cwd, parentTools: tools, parentSkills }, undefined);
	assert.equal(localAllowed.diagnostics.some((item) => item.severity === "error"), false);
	assert.equal(localAllowed.steps[0]?.agent.extensionTools[0]?.name, "local_search");
});

test("resolveDetachedGraph enforces graph library sources", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-library-${Date.now()}`), { recursive: true });
	const defaultDenied = resolveDetachedGraph(
		{ objective: "library", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "user:reviewer" }, task: "x" }] },
		[packageAgent(), userAgent()],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(defaultDenied.diagnostics.some((item) => item.code === "library-source-not-enabled"), true);
	assert.deepEqual(defaultDenied.steps, []);
	const allowed = resolveDetachedGraph(
		{ objective: "library", library: { sources: ["user"] }, authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "user:reviewer" }, task: "x" }] },
		[packageAgent(), userAgent()],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(allowed.diagnostics.some((item) => item.severity === "error"), false);
	assert.equal(allowed.steps[0]?.agent.ref, "user:reviewer");
});

test("resolveDetachedGraph materializes terminal after dependencies", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-after-${Date.now()}`), { recursive: true });
	const graph = resolveDetachedGraph(
		{
			objective: "after deps",
			authority: { allowFilesystemRead: true },
			steps: [
				{ id: "probe", agent: { system: "x" }, task: "x" },
				{ id: "synthesis", agent: { system: "x" }, task: "x", after: ["probe"] },
			],
		},
		[],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	assert.equal(graph.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(graph.steps[1]?.needs, []);
	assert.deepEqual(graph.steps[1]?.after, ["probe"]);
	const cycle = resolveDetachedGraph(
		{
			objective: "after cycle",
			authority: { allowFilesystemRead: true },
			steps: [
				{ id: "one", agent: { system: "x" }, task: "x", after: ["two"] },
				{ id: "two", agent: { system: "x" }, task: "x", needs: ["one"] },
			],
		},
		[],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	const cycleDiagnostic = cycle.diagnostics.find((item) => item.code === "dependency-cycle");
	assert.match(cycleDiagnostic?.message ?? "", /one --after--> two --needs--> one/);
});

test("resolveDetachedGraph resolves built-in tools independent of parent active built-ins", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-parent-tools-${Date.now()}`), { recursive: true });
	const graph = { objective: "parent tools", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { system: "x", tools: ["read"] }, task: "x" }] };
	const inventoryUnavailable = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools: { apiAvailable: false, errorMessage: "disabled", tools: [] }, parentSkills }, undefined);
	assert.equal(inventoryUnavailable.diagnostics.some((item) => item.severity === "error"), false);
	assert.deepEqual(inventoryUnavailable.steps[0]?.agent.tools, READONLY_CHILD_TOOL_NAMES);
	const inactive = resolveDetachedGraph(graph, [], [], { cwd, invocationCwd: cwd, parentTools: { apiAvailable: true, errorMessage: undefined, tools: activeBuiltinTools().map((tool) => ({ ...tool, active: false })) }, parentSkills }, undefined);
	assert.equal(inactive.diagnostics.some((item) => item.code.startsWith("builtin-tool-")), false);
	assert.deepEqual(inactive.steps[0]?.agent.tools, READONLY_CHILD_TOOL_NAMES);
});

test("resolveDetachedGraph denies lexical step cwd escapes before outside type probing", async () => {
	const parent = await mkdir(join(tmpdir(), `pi-multiagent-plan-cwd-escape-${Date.now()}`), { recursive: true });
	const cwd = await mkdir(join(parent, "workspace"), { recursive: true });
	const outside = await mkdir(join(parent, "outside"), { recursive: true });
	await writeFile(join(outside, "file.txt"), "x");
	const outsideFile = resolveDetachedGraph({ objective: "cwd", steps: [{ id: "one", agent: { system: "x" }, task: "x", cwd: "../outside/file.txt" }] }, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills }, undefined);
	assert.equal(outsideFile.diagnostics.some((item) => item.code === "cwd-path-escape-denied"), true);
	assert.equal(outsideFile.diagnostics.some((item) => item.code === "cwd-not-directory"), false);
	const outsideDir = resolveDetachedGraph({ objective: "cwd", steps: [{ id: "one", agent: { system: "x" }, task: "x", cwd: "../outside" }] }, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills }, undefined);
	assert.equal(outsideDir.diagnostics.some((item) => item.code === "cwd-path-escape-denied"), true);
	assert.equal(outsideDir.diagnostics.some((item) => item.code === "cwd-not-directory"), false);
	await symlink(outside, join(cwd, "link"));
	const linked = resolveDetachedGraph({ objective: "cwd", steps: [{ id: "one", agent: { system: "x" }, task: "x", cwd: "link" }] }, [], [], { cwd, invocationCwd: cwd, parentTools, parentSkills }, undefined);
	assert.equal(linked.diagnostics.some((item) => item.code === "cwd-symlink-denied"), true);
});

test("resolveDetachedGraph fails closed for authority and dependency violations", async () => {
	const cwd = await mkdir(join(tmpdir(), `pi-multiagent-plan-deny-${Date.now()}`), { recursive: true });
	await writeFile(join(cwd, "file.txt"), "x");
	const graph = resolveDetachedGraph(
		{
			objective: "deny",
			library: { sources: ["package", "project"] },
			steps: [
				{ id: "one", agent: { ref: "package:reviewer", tools: ["read"] }, task: "x", needs: ["missing"] },
				{ id: "two", agent: { system: "x", tools: ["bash"] }, task: "x", after: ["one", "missing-after"] },
			],
		},
		[packageAgent()],
		[],
		{ cwd, invocationCwd: cwd, parentTools, parentSkills },
		undefined,
	);
	const codes = graph.diagnostics.map((item) => item.code);
	assert.equal(codes.includes("filesystem-read-authority-required"), true);
	assert.equal(codes.includes("shell-authority-required"), true);
	assert.equal(codes.includes("dependency-unknown"), false);
	assert.deepEqual(graph.steps, []);
});
