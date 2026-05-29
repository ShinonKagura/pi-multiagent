/** Layer 3 (execution-runtime) tests.
 *
 * Scope: pure mapping from resolved profiles to detached `agent_team` start
 * graph inputs. No child launch or Pi tool registration belongs here.
 */

import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Compile } from "typebox/compile";

import type { Persona } from "../extensions/orchestra/src/agent-registry/types.ts";
import type { ResolvedProfile, ResolvedProfileAgent } from "../extensions/orchestra/src/profile-engine/types.ts";
import type { AgentConfig, ParentSkillInventory, ParentToolInfo, ParentToolInventory } from "../extensions/multiagent/src/types.ts";
import { profileToDetachedGraphStart } from "../extensions/orchestra/src/execution-runtime/profile-graph.ts";
import { resolveProfile } from "../extensions/orchestra/src/profile-engine/profile-composer.ts";
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
		frontmatter: {
			name,
			model: "anthropic/claude-sonnet-4-5",
			thinking: "medium",
			tools: ["read", "grep"],
			...overrides,
		},
		systemPrompt: `# Role\n${name}`,
		sourcePath: `/tmp/${name}.md`,
		source: "project",
	};
}

function packageAgent(name = "reviewer", thinking: AgentConfig["thinking"] = "high"): AgentConfig {
	return { name, ref: `package:${name}`, description: `${name} agent`, tags: [], tools: ["read"], model: "package/model", thinking, systemPrompt: "Review.", source: "package", filePath: `/tmp/${name}.md`, sha256: "abc" };
}

function resolvedProfile(kind: "chain" | "parallel", agents: ResolvedProfileAgent[]): ResolvedProfile {
	return {
		profile: { name: "profile", kind, agents: agents.map((agent) => agent.profileAgent), sharedSystemPrompt: "Shared", frontmatter: { name: "profile", kind, agents: agents.map((agent) => agent.profileAgent) }, sourcePath: "/tmp/profile.md", source: "project" },
		name: "profile",
		kind,
		agents,
		unresolvedAgents: [],
		diagnostics: [],
	};
}

test("profileToDetachedGraphStart: maps a parallel profile to schema-valid detached start graph", async () => {
	const sourceProfile = {
		name: "review",
		kind: "parallel" as const,
		agents: [
			{ subagent_type: "reviewer_one", model: "openai/gpt-5.5", tools: ["read", "bash"], thinking: "high" },
			{ subagent_type: "reviewer_two", tools: ["read", "grep"] },
		],
		sharedSystemPrompt: "Shared review guidance",
		frontmatter: { kind: "parallel" as const, agents: [] },
		sourcePath: "/tmp/review.md",
		source: "project" as const,
	};
	const resolved = resolveProfile(sourceProfile, (name) => name === "reviewer_one" ? persona("reviewer_one") : name === "reviewer_two" ? persona("reviewer_two", { model: "deepseek/deepseek-v4-pro", thinking: "low" }) : undefined);
	const result = profileToDetachedGraphStart(resolved, { objective: "Run parallel review", task: "Review this diff" });

	assert.equal(result.action, "start");
	assert.deepEqual(result.diagnostics, []);
	assert.ok(result.graph);
	assert.equal(validateAgentTeam.Check({ action: "start", graph: result.graph }), true);
	assert.equal(result.graph.steps.length, 2);
	assert.equal(result.graph.steps[0].id, "reviewer-one");
	assert.equal(result.graph.steps[0].agent.model, "openai/gpt-5.5");
	assert.equal(result.graph.steps[0].agent.thinking, "high");
	assert.equal(result.graph.steps[0].agent.system?.includes("Shared review guidance"), true);
	assert.deepEqual(result.graph.steps[0].agent.tools, ["read", "bash"]);
	assert.equal(result.graph.authority?.allowFilesystemRead, true);
	assert.equal(result.graph.authority?.allowShellTools, true);
	assert.equal(result.graph.limits?.concurrency, 2);

	const cwd = await mkdir(join(tmpdir(), `hb-orchestra-l3-${Date.now()}`), { recursive: true });
	const planned = resolveDetachedGraph(result.graph, [], [], { invocationCwd: cwd, parentTools, parentSkills }, {});
	assert.deepEqual(planned.diagnostics.filter((item) => item.severity === "error"), []);
	assert.equal(planned.steps[0]?.agent.model, "openai/gpt-5.5");
	assert.equal(planned.steps[0]?.agent.thinking, "high");
});

test("profileToDetachedGraphStart: maps chain profiles with strict dependencies", () => {
	const a = resolveProfile({ name: "chain", kind: "chain", agents: [{ subagent_type: "analysis_agent" }, { subagent_type: "review_agent" }], sharedSystemPrompt: "", frontmatter: { kind: "chain", agents: [] }, sourcePath: "/tmp/chain.md", source: "project" }, (name) => persona(name));
	const result = profileToDetachedGraphStart(a, { objective: "Run chain", task: "Analyze then review" });
	assert.ok(result.graph);
	assert.equal(result.graph.steps[0].needs, undefined);
	assert.deepEqual(result.graph.steps[1].needs, ["analysis-agent"]);
	assert.equal(result.graph.limits?.concurrency, 1);
});

test("profileToDetachedGraphStart: rejects unresolved profile agents", () => {
	const unresolved = resolvedProfile("parallel", []);
	unresolved.unresolvedAgents = [{ profileAgent: { subagent_type: "missing" }, subagent_type: "missing", diagnostic: { code: "profile-persona-not-found", message: "missing", severity: "error" } }];
	unresolved.diagnostics = [unresolved.unresolvedAgents[0].diagnostic];
	const result = profileToDetachedGraphStart(unresolved, { objective: "x", task: "x" });
	assert.equal(result.graph, undefined);
	assert.equal(result.diagnostics.some((item) => item.code === "profile-graph-unresolved-agents"), true);
});

test("profileToDetachedGraphStart: requires mutationScope for edit/write tools", () => {
	const sourceProfile = resolveProfile({ name: "mut", kind: "parallel", agents: [{ subagent_type: "worker" }], sharedSystemPrompt: "", frontmatter: { kind: "parallel", agents: [] }, sourcePath: "/tmp/mut.md", source: "project" }, () => persona("worker", { tools: ["read", "edit"] }));
	const denied = profileToDetachedGraphStart(sourceProfile, { objective: "Mutate", task: "Edit file" });
	assert.equal(denied.graph, undefined);
	assert.equal(denied.diagnostics.some((item) => item.code === "profile-graph-mutation-scope-required"), true);
	const allowed = profileToDetachedGraphStart(sourceProfile, { objective: "Mutate", task: "Edit file", mutationScope: "edit files under src/" });
	assert.ok(allowed.graph);
	assert.equal(allowed.graph.authority?.allowMutationTools, true);
	assert.equal(allowed.graph.steps[0].mutationScope, "edit files under src/");
});

test("profileToDetachedGraphStart: rejects invalid resolved thinking values before schema handoff", () => {
	const sourceProfile = resolveProfile({ name: "bad-thinking", kind: "parallel", agents: [{ subagent_type: "thinker" }], sharedSystemPrompt: "", frontmatter: { kind: "parallel", agents: [] }, sourcePath: "/tmp/bad-thinking.md", source: "project" }, () => persona("thinker", { thinking: "sideways" }));
	const result = profileToDetachedGraphStart(sourceProfile, { objective: "Think", task: "Think" });
	assert.equal(result.graph, undefined);
	assert.equal(result.diagnostics.some((item) => item.code === "profile-graph-thinking-invalid"), true);
});

test("resolveDetachedGraph: library step thinking inherit means parent defaults, not library default", async () => {
	const cwd = await mkdir(join(tmpdir(), `hb-orchestra-l3-library-${Date.now()}`), { recursive: true });
	const inherited = resolveDetachedGraph({ objective: "x", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "package:reviewer", thinking: "inherit" }, task: "x" }] }, [packageAgent()], [], { invocationCwd: cwd, parentTools, parentSkills }, {});
	assert.deepEqual(inherited.diagnostics.filter((item) => item.severity === "error"), []);
	assert.equal(inherited.steps[0]?.agent.thinking, undefined);

	const omitted = resolveDetachedGraph({ objective: "x", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "package:reviewer" }, task: "x" }] }, [packageAgent()], [], { invocationCwd: cwd, parentTools, parentSkills }, {});
	assert.equal(omitted.steps[0]?.agent.thinking, "high");

	const override = resolveDetachedGraph({ objective: "x", authority: { allowFilesystemRead: true }, steps: [{ id: "one", agent: { ref: "package:reviewer", thinking: "low", model: "override/model" }, task: "x" }] }, [packageAgent()], [], { invocationCwd: cwd, parentTools, parentSkills }, {});
	assert.equal(override.steps[0]?.agent.thinking, "low");
	assert.equal(override.steps[0]?.agent.model, "override/model");
});
