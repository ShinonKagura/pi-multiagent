/** Layer 2 (profile-engine) tests.
 *
 * Scope: contract loading/validation only. No persona resolution, graph building,
 * runtime model fallback, or detached execution wiring belongs here.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Persona } from "../extensions/orchestra/src/agent-registry/types.ts";
import type { ProfileDefinition } from "../extensions/orchestra/src/profile-engine/types.ts";
import { resolveProfile } from "../extensions/orchestra/src/profile-engine/profile-composer.ts";
import { findProfile, listAllProfiles } from "../extensions/orchestra/src/profile-engine/profile-loader.ts";

function makeFixture(): { cwd: string; profilesDir: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), "hb-orchestra-profile-fixture-"));
	const profilesDir = join(cwd, ".pi", "profiles");
	mkdirSync(profilesDir, { recursive: true });
	return { cwd, profilesDir, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function makePersona(name: string, overrides: Partial<Persona["frontmatter"]> = {}): Persona {
	return {
		frontmatter: {
			name,
			model: "anthropic/claude-sonnet-4-5",
			fallbackModels: ["openai/gpt-5"],
			thinking: "medium",
			tools: ["read", "grep"],
			inheritProjectContext: true,
			inheritSkills: true,
			defaultContext: "fork",
			...overrides,
		},
		systemPrompt: `# Role\n${name} persona`,
		sourcePath: `/tmp/${name}.md`,
		source: "project",
	};
}

function makeProfile(agents: ProfileDefinition["agents"], sharedSystemPrompt = "Shared guidance"): ProfileDefinition {
	return {
		name: "review",
		kind: "parallel",
		agents,
		sharedSystemPrompt,
		frontmatter: { kind: "parallel", agents, name: "review" },
		sourcePath: "/tmp/review.md",
		source: "project",
	};
}

test("findProfile: loads a markdown parallel profile with shared prompt", () => {
	const fx = makeFixture();
	try {
		writeFileSync(join(fx.profilesDir, "review.md"), `---
kind: parallel
description: Parallel review profile
tags: review, qa
agents:
  - subagent_type: reviewer-claude
    model: anthropic/claude-sonnet-4-5
    fallbackModels: openai/gpt-5, deepseek/deepseek-v4
    thinking: medium
    tools: read, grep
    inherit_context: true
    max_turns: 8
  - subagent_type: qa-deepseek
    model: deepseek/deepseek-v4-pro
---
# Shared prompt
Review the implementation independently.
`, "utf8");

		const lookup = findProfile("review", { invocationCwd: fx.cwd });
		assert.equal(lookup.diagnostic, undefined);
		assert.ok(lookup.profile);
		assert.equal(lookup.profile!.name, "review");
		assert.equal(lookup.profile!.kind, "parallel");
		assert.equal(lookup.profile!.source, "project");
		assert.deepEqual(lookup.profile!.frontmatter.tags, ["review", "qa"]);
		assert.equal(lookup.profile!.agents.length, 2);
		assert.equal(lookup.profile!.agents[0].subagent_type, "reviewer-claude");
		assert.deepEqual(lookup.profile!.agents[0].fallbackModels, ["openai/gpt-5", "deepseek/deepseek-v4"]);
		assert.deepEqual(lookup.profile!.agents[0].tools, ["read", "grep"]);
		assert.equal(lookup.profile!.agents[0].inherit_context, true);
		assert.equal(lookup.profile!.agents[0].max_turns, 8);
		assert.match(lookup.profile!.sharedSystemPrompt, /Shared prompt/);
	} finally {
		fx.cleanup();
	}
});

test("findProfile: loads a JSON chain profile", () => {
	const fx = makeFixture();
	try {
		writeFileSync(join(fx.profilesDir, "chain.json"), JSON.stringify({
			kind: "chain",
			agents: [
				{ subagent_type: "codebase-analyzer", model: "openai/gpt-5" },
				{ subagent_type: "coding_reviewer", thinking: "high" },
			],
			sharedSystemPrompt: "Analyze first, review second.",
		}, null, 2), "utf8");

		const lookup = findProfile("chain", { invocationCwd: fx.cwd });
		assert.equal(lookup.diagnostic, undefined);
		assert.ok(lookup.profile);
		assert.equal(lookup.profile!.kind, "chain");
		assert.equal(lookup.profile!.agents[1].subagent_type, "coding_reviewer");
		assert.equal(lookup.profile!.sharedSystemPrompt, "Analyze first, review second.");
	} finally {
		fx.cleanup();
	}
});

test("findProfile: resolves case-insensitive profile filenames", () => {
	const fx = makeFixture();
	try {
		writeFileSync(join(fx.profilesDir, "ReviewTeam.MD"), `---
kind: parallel
agents:
  - subagent_type: coding_reviewer
---
`, "utf8");
		const lookup = findProfile("reviewteam", { invocationCwd: fx.cwd });
		assert.equal(lookup.diagnostic, undefined);
		assert.ok(lookup.profile);
		assert.equal(lookup.profile!.name, "ReviewTeam");
	} finally {
		fx.cleanup();
	}
});

test("listAllProfiles: handles missing profile directory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "hb-orchestra-profile-missing-"));
	try {
		const catalog = listAllProfiles({ invocationCwd: cwd });
		assert.deepEqual(catalog.profiles, []);
		assert.equal(catalog.diagnostics.length, 0);
		assert.equal(catalog.searchedDirs.length, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("listAllProfiles: records invalid profile diagnostics", () => {
	const fx = makeFixture();
	try {
		writeFileSync(join(fx.profilesDir, "bad.md"), `---
kind: fanout
agents:
  - subagent_type: coding_reviewer
---
`, "utf8");
		const catalog = listAllProfiles({ invocationCwd: fx.cwd });
		assert.deepEqual(catalog.profiles, []);
		assert.equal(catalog.diagnostics.length, 1);
		assert.equal(catalog.diagnostics[0].code, "profile-frontmatter-invalid");
	} finally {
		fx.cleanup();
	}
});

test("findProfile: rejects agents missing subagent_type", () => {
	const fx = makeFixture();
	try {
		writeFileSync(join(fx.profilesDir, "bad-agent.json"), JSON.stringify({ kind: "parallel", agents: [{ model: "openai/gpt-5" }] }), "utf8");
		const lookup = findProfile("bad-agent", { invocationCwd: fx.cwd });
		assert.equal(lookup.profile, undefined);
		assert.match(lookup.diagnostic ?? "", /subagent_type/);
	} finally {
		fx.cleanup();
	}
});

test("resolveProfile: merges persona defaults with profile agent overrides", () => {
	const profile = makeProfile([
		{
			subagent_type: "coding_reviewer",
			model: "openai/gpt-5.5",
			fallbackModels: ["deepseek/deepseek-v4"],
			thinking: "high",
			tools: ["read", "bash"],
			inherit_context: false,
			max_turns: 5,
		},
	]);
	const persona = makePersona("coding_reviewer");
	const resolved = resolveProfile(profile, (name) => name === "coding_reviewer" ? persona : undefined);

	assert.equal(resolved.diagnostics.length, 0);
	assert.equal(resolved.unresolvedAgents.length, 0);
	assert.equal(resolved.agents.length, 1);
	const agent = resolved.agents[0];
	assert.equal(agent.persona, persona);
	assert.equal(agent.model, "openai/gpt-5.5");
	assert.deepEqual(agent.fallbackModels, ["deepseek/deepseek-v4"]);
	assert.equal(agent.thinking, "high");
	assert.deepEqual(agent.tools, ["read", "bash"]);
	assert.equal(agent.inherit_context, false);
	assert.equal(agent.inheritSkills, true);
	assert.equal(agent.defaultContext, "fork");
	assert.equal(agent.max_turns, 5);
	assert.match(agent.systemPrompt, /coding_reviewer persona\n---\nShared guidance/);
});

test("resolveProfile: uses persona defaults when profile agent omits overrides", () => {
	const profile = makeProfile([{ subagent_type: "codebase-analyzer" }], "");
	const persona = makePersona("codebase-analyzer", { model: "deepseek-v4-pro:cloud", tools: ["read", "find"], inheritProjectContext: false });
	const resolved = resolveProfile(profile, (name) => name === "codebase-analyzer" ? persona : undefined);
	const agent = resolved.agents[0];
	assert.equal(agent.model, "deepseek-v4-pro:cloud");
	assert.deepEqual(agent.fallbackModels, ["openai/gpt-5"]);
	assert.deepEqual(agent.tools, ["read", "find"]);
	assert.equal(agent.inherit_context, false);
	assert.equal(agent.systemPrompt, persona.systemPrompt);
});

test("resolveProfile: records diagnostics for missing personas and continues", () => {
	const profile = makeProfile([{ subagent_type: "missing" }, { subagent_type: "coding_reviewer" }]);
	const persona = makePersona("coding_reviewer");
	const resolved = resolveProfile(profile, (name) => name === "coding_reviewer" ? persona : undefined);
	assert.equal(resolved.agents.length, 1);
	assert.equal(resolved.unresolvedAgents.length, 1);
	assert.equal(resolved.unresolvedAgents[0].subagent_type, "missing");
	assert.equal(resolved.diagnostics[0].code, "profile-persona-not-found");
});
