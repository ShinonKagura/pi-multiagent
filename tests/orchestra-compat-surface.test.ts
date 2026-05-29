/** Layer 6 (compat-surface) tests.
 *
 * Scope: pure mapping from one resolved Layer-1 persona + pi-subagents-compatible
 * Agent() invocation params to a single-step detached `agent_team` start graph.
 * Each produced graph is validated against the public AgentTeamSchema AND planned
 * through the real `resolveDetachedGraph` substrate so this proves plannability,
 * not just schema shape. No child launch or Pi tool registration belongs here.
 */

import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Compile } from "typebox/compile";

import type { Persona } from "../extensions/orchestra/src/agent-registry/types.ts";
import type { ParentSkillInventory, ParentToolInfo, ParentToolInventory } from "../extensions/multiagent/src/types.ts";
import { agentInvocationToDetachedGraphStart } from "../extensions/orchestra/src/compat-surface/agent-graph.ts";
import { resolveDetachedGraph } from "../extensions/multiagent/src/planning.ts";
import { AgentTeamSchema } from "../extensions/multiagent/src/schemas.ts";
import { BUILTIN_CHILD_TOOL_NAMES } from "../extensions/multiagent/src/types.ts";

const validateAgentTeam = Compile(AgentTeamSchema);
const parentTools: ParentToolInventory = { apiAvailable: true, errorMessage: undefined, tools: activeBuiltinTools() };
const parentSkills: ParentSkillInventory = { apiAvailable: true, readActive: true, errorMessage: undefined, skills: [] };

function activeBuiltinTools(): ParentToolInfo[] {
	return BUILTIN_CHILD_TOOL_NAMES.map((name) => ({ name, description: `${name} tool`, sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level", baseDir: undefined }, active: true }));
}

function persona(name: string, overrides: Partial<Persona["frontmatter"]> = {}): Persona {
	return {
		frontmatter: { name, model: "anthropic/claude-sonnet-4-5", thinking: "medium", tools: ["read", "grep"], ...overrides },
		systemPrompt: `# Role\n${name} persona body`,
		sourcePath: `/tmp/${name}.md`,
		source: "project",
	};
}

async function planGraph(graph: NonNullable<ReturnType<typeof agentInvocationToDetachedGraphStart>["graph"]>) {
	const cwd = await mkdir(join(tmpdir(), `hb-orchestra-l6-${Date.now()}-${Math.random().toString(36).slice(2)}`), { recursive: true });
	return resolveDetachedGraph(graph, [], [], { invocationCwd: cwd, parentTools, parentSkills }, {});
}

test("agentInvocationToDetachedGraphStart: maps a persona to a schema-valid, plannable single-step graph", async () => {
	const result = agentInvocationToDetachedGraphStart(persona("coding_reviewer"), { subagent_type: "coding_reviewer", prompt: "Review this diff", description: "Independent review" });

	assert.equal(result.action, "start");
	assert.deepEqual(result.diagnostics, []);
	assert.ok(result.graph);
	assert.equal(validateAgentTeam.Check({ action: "start", graph: result.graph }), true);
	assert.equal(result.graph.steps.length, 1);
	assert.equal(result.graph.objective, "Independent review");
	assert.equal(result.graph.steps[0].id, "coding-reviewer");
	assert.equal(result.graph.steps[0].task, "Review this diff");
	assert.equal(result.graph.steps[0].agent.model, "anthropic/claude-sonnet-4-5");
	assert.equal(result.graph.steps[0].agent.thinking, "medium");
	assert.deepEqual(result.graph.steps[0].agent.tools, ["read", "grep"]);
	assert.equal(result.graph.steps[0].agent.system?.includes("coding_reviewer persona body"), true);
	assert.equal(result.graph.authority?.allowFilesystemRead, true);
	assert.equal(result.graph.authority?.allowShellTools, false);
	assert.equal(result.graph.authority?.allowMutationTools, false);

	const planned = await planGraph(result.graph);
	assert.deepEqual(planned.diagnostics.filter((item) => item.severity === "error"), []);
	assert.equal(planned.steps[0]?.agent.model, "anthropic/claude-sonnet-4-5");
	assert.equal(planned.steps[0]?.agent.thinking, "medium");
});

test("agentInvocationToDetachedGraphStart: invocation overrides beat persona frontmatter", () => {
	const result = agentInvocationToDetachedGraphStart(persona("scout"), { subagent_type: "scout", prompt: "Explore", model: "openai/gpt-5.5", thinking: "high", tools: ["read", "bash"] });
	assert.ok(result.graph);
	assert.equal(result.graph.steps[0].agent.model, "openai/gpt-5.5");
	assert.equal(result.graph.steps[0].agent.thinking, "high");
	assert.deepEqual(result.graph.steps[0].agent.tools, ["read", "bash"]);
	assert.equal(result.graph.authority?.allowShellTools, true);
});

test("agentInvocationToDetachedGraphStart: defaults objective from subagent_type when description omitted", () => {
	const result = agentInvocationToDetachedGraphStart(persona("planner"), { subagent_type: "planner", prompt: "Plan the work" });
	assert.ok(result.graph);
	assert.equal(result.graph.objective, "Agent planner");
});

test("agentInvocationToDetachedGraphStart: requires a non-empty prompt", () => {
	const result = agentInvocationToDetachedGraphStart(persona("scout"), { subagent_type: "scout", prompt: "   " });
	assert.equal(result.graph, undefined);
	assert.equal(result.diagnostics.some((item) => item.code === "agent-prompt-required"), true);
});

test("agentInvocationToDetachedGraphStart: requires mutationScope for edit/write tools and infers worktree authority", async () => {
	const worker = persona("worker", { tools: ["read", "edit"] });
	const denied = agentInvocationToDetachedGraphStart(worker, { subagent_type: "worker", prompt: "Edit file" });
	assert.equal(denied.graph, undefined);
	assert.equal(denied.diagnostics.some((item) => item.code === "agent-mutation-scope-required"), true);

	const allowed = agentInvocationToDetachedGraphStart(worker, { subagent_type: "worker", prompt: "Edit file", mutationScope: "edit files under src/", isolation: "worktree" });
	assert.ok(allowed.graph);
	assert.equal(allowed.graph.authority?.allowMutationTools, true);
	assert.equal(allowed.graph.authority?.allowMutationWorktree, true);
	assert.equal(allowed.graph.steps[0].mutationScope, "edit files under src/");
	assert.equal(allowed.graph.steps[0].isolation, "worktree");
	const planned = await planGraph(allowed.graph);
	assert.deepEqual(planned.diagnostics.filter((item) => item.severity === "error"), []);
});

test("agentInvocationToDetachedGraphStart: rejects invalid thinking before schema handoff", () => {
	const result = agentInvocationToDetachedGraphStart(persona("thinker", { thinking: "sideways" }), { subagent_type: "thinker", prompt: "Think" });
	assert.equal(result.graph, undefined);
	assert.equal(result.diagnostics.some((item) => item.code === "agent-thinking-invalid"), true);
});
