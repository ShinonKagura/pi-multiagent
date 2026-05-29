/**
 * Layer 1 (agent-registry) tests.
 *
 * Two test groups:
 *   1. Fixture-based: temp dir with a hand-written `.pi/agents/<name>.md`.
 *      Runs under all environments, no external dependency.
 *   2. Optional stellar-integration: only runs when `/mnt/DEV/stellar/.pi/agents`
 *      exists. Verifies real-world persona load against Mark's authoring style.
 *
 * Run via `pnpm test`.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findPersona, listAllPersonas } from "../extensions/orchestra/src/agent-registry/persona-loader.ts";

function makeFixture(personaBody: string): { cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(join(tmpdir(), "hb-orchestra-fixture-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", "test_persona.md"), personaBody, "utf8");
	return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("findPersona: loads a project-scoped persona file with full frontmatter", () => {
	const body = `---
name: test_persona
package: coding
description: Test persona
model: anthropic/claude-sonnet-4-5
fallbackModels: openai-codex/gpt-5.3-codex, openai-codex/gpt-5.2
tools: read, bash, grep
thinking: medium
inheritProjectContext: true
inheritSkills: false
defaultContext: fork
systemPromptMode: append
---
# Role
You are a test persona used by hb-orchestra agent-registry unit tests.
`;
	const fx = makeFixture(body);
	try {
		const lookup = findPersona("test_persona", { invocationCwd: fx.cwd });
		assert.equal(lookup.diagnostic, undefined, "no diagnostic expected on success");
		assert.ok(lookup.persona, "persona must be defined");
		const p = lookup.persona!;
		assert.equal(p.source, "project", "must resolve from project scope (.pi/agents/)");
		assert.equal(p.frontmatter.name, "test_persona");
		assert.equal(p.frontmatter.package, "coding");
		assert.equal(p.frontmatter.model, "anthropic/claude-sonnet-4-5");
		assert.deepEqual(p.frontmatter.fallbackModels, ["openai-codex/gpt-5.3-codex", "openai-codex/gpt-5.2"]);
		assert.deepEqual(p.frontmatter.tools, ["read", "bash", "grep"]);
		assert.equal(p.frontmatter.thinking, "medium");
		assert.equal(p.frontmatter.inheritProjectContext, true);
		assert.equal(p.frontmatter.inheritSkills, false);
		assert.equal(p.frontmatter.defaultContext, "fork");
		assert.equal(p.frontmatter.systemPromptMode, "append");
		assert.match(p.systemPrompt, /^# Role/, "system prompt body must start with the markdown heading");
	} finally {
		fx.cleanup();
	}
});

test("findPersona: returns a structured diagnostic when persona is missing", () => {
	const fx = makeFixture("---\nname: ignored\n---\nbody");
	try {
		const lookup = findPersona("does_not_exist_anywhere", { invocationCwd: fx.cwd });
		assert.equal(lookup.persona, undefined);
		assert.ok(lookup.diagnostic, "diagnostic must be present on miss");
		assert.match(lookup.diagnostic!, /persona-not-found/);
	} finally {
		fx.cleanup();
	}
});

test("findPersona: rejects empty persona name", () => {
	const lookup = findPersona("   ", { invocationCwd: "/" });
	assert.equal(lookup.persona, undefined);
	assert.match(lookup.diagnostic ?? "", /empty/);
});

test("findPersona: bracket-style list parsing", () => {
	const body = `---
name: bracket_test
tools: [read, grep, find]
fallbackModels: ["openai/gpt-5", "anthropic/claude-sonnet"]
---
body
`;
	const fx = makeFixture(body.replace("test_persona", "bracket_test"));
	try {
		// We wrote under filename "test_persona.md" by convention; rename for this test.
		// Reuse the temp dir but write the actual filename used by the test.
		rmSync(join(fx.cwd, ".pi", "agents", "test_persona.md"));
		writeFileSync(join(fx.cwd, ".pi", "agents", "bracket_test.md"), body, "utf8");
		const lookup = findPersona("bracket_test", { invocationCwd: fx.cwd });
		assert.ok(lookup.persona, "persona expected");
		assert.deepEqual(lookup.persona!.frontmatter.tools, ["read", "grep", "find"]);
		assert.deepEqual(lookup.persona!.frontmatter.fallbackModels, ["openai/gpt-5", "anthropic/claude-sonnet"]);
	} finally {
		fx.cleanup();
	}
});

test("findPersona: integration with stellar/.pi/agents/coding_reviewer.md (optional)", { skip: !existsSync("/mnt/DEV/stellar/.pi/agents/coding_reviewer.md") }, () => {
	const lookup = findPersona("coding_reviewer", { invocationCwd: "/mnt/DEV/stellar" });
	assert.equal(lookup.diagnostic, undefined, "stellar coding_reviewer must resolve");
	assert.ok(lookup.persona, "persona expected");
	const p = lookup.persona!;
	assert.equal(p.source, "project");
	assert.equal(p.frontmatter.name, "coding_reviewer");
	assert.ok(p.frontmatter.model, "model field expected");
	assert.ok(Array.isArray(p.frontmatter.fallbackModels), "fallbackModels expected to be an array");
	assert.ok(Array.isArray(p.frontmatter.tools), "tools expected to be an array");
	assert.match(p.systemPrompt, /Role/, "system prompt body expected");
});

test("listAllPersonas: enumerates project personas and ignores missing search dirs", () => {
	const fx = makeFixture(`---
name: alpha_agent
package: coding
---
Alpha body
`);
	try {
		rmSync(join(fx.cwd, ".pi", "agents", "test_persona.md"));
		writeFileSync(join(fx.cwd, ".pi", "agents", "alpha_agent.md"), `---
name: alpha_agent
tools: read, grep
---
Alpha body
`, "utf8");
		writeFileSync(join(fx.cwd, ".pi", "agents", "beta_agent.md"), `---
name: beta_agent
inheritSkills: true
---
Beta body
`, "utf8");

		const catalog = listAllPersonas({ invocationCwd: fx.cwd, userHomeDir: join(fx.cwd, "missing-home") });
		assert.deepEqual(catalog.personas.map((p) => p.frontmatter.name), ["alpha_agent", "beta_agent"]);
		assert.equal(catalog.diagnostics.length, 0);
		assert.equal(catalog.personas[0].source, "project");
	} finally {
		fx.cleanup();
	}
});

test("findPersona: project persona shadows workspace/user/builtin with same name", () => {
	const fx = makeFixture(`---
name: shared_agent
package: project
---
Project body
`);
	try {
		rmSync(join(fx.cwd, ".pi", "agents", "test_persona.md"));
		writeFileSync(join(fx.cwd, ".pi", "agents", "shared_agent.md"), `---
name: shared_agent
package: project
---
Project body
`, "utf8");
		mkdirSync(join(fx.cwd, ".agents", "agents"), { recursive: true });
		writeFileSync(join(fx.cwd, ".agents", "agents", "shared_agent.md"), `---
name: shared_agent
package: workspace
---
Workspace body
`, "utf8");
		const userHomeDir = join(fx.cwd, "home");
		mkdirSync(join(userHomeDir, ".pi", "agent", "agents"), { recursive: true });
		writeFileSync(join(userHomeDir, ".pi", "agent", "agents", "shared_agent.md"), `---
name: shared_agent
package: user
---
User body
`, "utf8");
		const builtinAgentDir = join(fx.cwd, "builtin");
		mkdirSync(builtinAgentDir, { recursive: true });
		writeFileSync(join(builtinAgentDir, "shared_agent.md"), `---
name: shared_agent
package: builtin
---
Builtin body
`, "utf8");

		const lookup = findPersona("shared_agent", { invocationCwd: fx.cwd, userHomeDir, builtinAgentDir });
		assert.equal(lookup.diagnostic, undefined);
		assert.ok(lookup.persona);
		assert.equal(lookup.persona!.source, "project");
		assert.equal(lookup.persona!.frontmatter.package, "project");
	} finally {
		fx.cleanup();
	}
});

test("findPersona: accepts frontmatter without a body newline", () => {
	const fx = makeFixture("---\nname: ignored\n---\nbody");
	try {
		rmSync(join(fx.cwd, ".pi", "agents", "test_persona.md"));
		writeFileSync(join(fx.cwd, ".pi", "agents", "no_body.md"), "---\nname: no_body\n---", "utf8");
		const lookup = findPersona("no_body", { invocationCwd: fx.cwd, userHomeDir: join(fx.cwd, "missing-home") });
		assert.equal(lookup.diagnostic, undefined);
		assert.ok(lookup.persona);
		assert.equal(lookup.persona!.systemPrompt, "");
	} finally {
		fx.cleanup();
	}
});

test("findPersona: resolves case-insensitive filenames", () => {
	const fx = makeFixture("---\nname: ignored\n---\nbody");
	try {
		rmSync(join(fx.cwd, ".pi", "agents", "test_persona.md"));
		writeFileSync(join(fx.cwd, ".pi", "agents", "Case_Agent.md"), `---
name: Case_Agent
---
Case body
`, "utf8");
		const lookup = findPersona("case_agent", { invocationCwd: fx.cwd });
		assert.equal(lookup.diagnostic, undefined);
		assert.ok(lookup.persona);
		assert.equal(lookup.persona!.frontmatter.name, "Case_Agent");
	} finally {
		fx.cleanup();
	}
});

test("findPersona: resolves a unique fuzzy persona match", () => {
	const fx = makeFixture("---\nname: ignored\n---\nbody");
	try {
		rmSync(join(fx.cwd, ".pi", "agents", "test_persona.md"));
		writeFileSync(join(fx.cwd, ".pi", "agents", "coding_reviewer.md"), `---
name: coding_reviewer
---
Reviewer body
`, "utf8");
		const lookup = findPersona("reviewer", { invocationCwd: fx.cwd });
		assert.equal(lookup.diagnostic, undefined);
		assert.ok(lookup.persona);
		assert.equal(lookup.persona!.frontmatter.name, "coding_reviewer");
	} finally {
		fx.cleanup();
	}
});

test("findPersona: reports ambiguous fuzzy matches", () => {
	const fx = makeFixture("---\nname: ignored\n---\nbody");
	try {
		rmSync(join(fx.cwd, ".pi", "agents", "test_persona.md"));
		writeFileSync(join(fx.cwd, ".pi", "agents", "coding_reviewer.md"), "---\nname: coding_reviewer\n---\nbody", "utf8");
		writeFileSync(join(fx.cwd, ".pi", "agents", "docs_reviewer.md"), "---\nname: docs_reviewer\n---\nbody", "utf8");
		const lookup = findPersona("reviewer", { invocationCwd: fx.cwd });
		assert.equal(lookup.persona, undefined);
		assert.match(lookup.diagnostic ?? "", /ambiguous/);
	} finally {
		fx.cleanup();
	}
});

test("listAllPersonas: records invalid frontmatter diagnostics", () => {
	const fx = makeFixture("---\nname: ignored\n---\nbody");
	try {
		rmSync(join(fx.cwd, ".pi", "agents", "test_persona.md"));
		writeFileSync(join(fx.cwd, ".pi", "agents", "bad_agent.md"), `---
name: bad_agent
inheritSkills: maybe
---
Bad body
`, "utf8");
		const catalog = listAllPersonas({ invocationCwd: fx.cwd, userHomeDir: join(fx.cwd, "missing-home") });
		assert.deepEqual(catalog.personas, []);
		assert.equal(catalog.diagnostics.length, 1);
		assert.equal(catalog.diagnostics[0].code, "persona-frontmatter-invalid");
	} finally {
		fx.cleanup();
	}
});
