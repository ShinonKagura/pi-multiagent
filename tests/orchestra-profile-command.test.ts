/** Layer 6 profile-command wiring tests.
 *
 * Exercises the exact resolution path that the `Profile` tool and `/profile` command use in
 * `extensions/orchestra/index.ts` (`startProfileRun`): on-disk `findProfile` (Layer 2) -> persona
 * lookup via `findPersona` (Layer 1) -> `profileToDetachedGraphStart` (Layer 3) -> a
 * `resolveDetachedGraph`-plannable detached start graph. The Pi tool/command registration and the
 * `runAgentTeam` launch are out of scope here (covered by the real-Pi smoke).
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findPersona } from "../extensions/orchestra/src/agent-registry/index.ts";
import { profileToDetachedGraphStart } from "../extensions/orchestra/src/execution-runtime/profile-graph.ts";
import { findProfile, resolveProfile } from "../extensions/orchestra/src/profile-engine/index.ts";
import { resolveDetachedGraph } from "../extensions/multiagent/src/planning.ts";
import { BUILTIN_CHILD_TOOL_NAMES } from "../extensions/multiagent/src/types.ts";
import type { ParentSkillInventory, ParentToolInfo, ParentToolInventory } from "../extensions/multiagent/src/types.ts";

const parentTools: ParentToolInventory = {
	apiAvailable: true,
	errorMessage: undefined,
	tools: BUILTIN_CHILD_TOOL_NAMES.map((name): ParentToolInfo => ({
		name,
		description: `${name} tool`,
		sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level", baseDir: undefined },
		active: true,
	})),
};
const parentSkills: ParentSkillInventory = { apiAvailable: true, readActive: true, errorMessage: undefined, skills: [] };

function fixture(): string {
	const cwd = mkdtempSync(join(tmpdir(), "hb-orchestra-profile-cmd-"));
	mkdirSync(join(cwd, ".pi", "profiles"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	for (const name of ["alpha", "beta"]) {
		writeFileSync(
			join(cwd, ".pi", "agents", `${name}.md`),
			`---\nname: ${name}\nmodel: anthropic/claude-sonnet-4-5\nthinking: medium\ntools: read, grep\n---\n# ${name}\nDo ${name} work.\n`,
			"utf8",
		);
	}
	return cwd;
}

/** Same persona-lookup closure that `startProfileRun` builds. */
function personaLookup(cwd: string) {
	return (subagentType: string) => findPersona(subagentType, { invocationCwd: cwd, userHomeDir: homedir(), builtinAgentDir: join(cwd, ".pi", "agents") }).persona;
}

test("profile wiring: on-disk parallel profile resolves members and maps to a plannable detached graph", () => {
	const cwd = fixture();
	writeFileSync(
		join(cwd, ".pi", "profiles", "team.md"),
		`---\nkind: parallel\nagents:\n  - subagent_type: alpha\n  - subagent_type: beta\n---\nReview from two angles.\n`,
		"utf8",
	);

	const lookup = findProfile("team", { invocationCwd: cwd });
	assert.equal(lookup.diagnostic, undefined);
	assert.ok(lookup.profile, "profile loads from .pi/profiles");

	const resolved = resolveProfile(lookup.profile, personaLookup(cwd));
	assert.equal(resolved.unresolvedAgents.length, 0, "both members resolve via findPersona");
	assert.equal(resolved.agents.length, 2);

	const mapped = profileToDetachedGraphStart(resolved, { objective: "Team review", task: "Review the diff" });
	assert.ok(mapped.graph, "maps to a detached start graph");
	assert.equal(mapped.diagnostics.some((d) => d.severity === "error"), false);

	const planned = resolveDetachedGraph(mapped.graph!, [], [], { invocationCwd: cwd, parentTools, parentSkills }, {});
	assert.ok(planned, "graph is resolveDetachedGraph-plannable");
});

test("profile wiring: an unresolved member persona blocks the graph with an error diagnostic", () => {
	const cwd = fixture();
	writeFileSync(
		join(cwd, ".pi", "profiles", "broken.md"),
		`---\nkind: chain\nagents:\n  - subagent_type: alpha\n  - subagent_type: ghost\n---\nChain.\n`,
		"utf8",
	);

	const lookup = findProfile("broken", { invocationCwd: cwd });
	assert.ok(lookup.profile);

	const resolved = resolveProfile(lookup.profile, personaLookup(cwd));
	assert.ok(resolved.unresolvedAgents.some((a) => a.subagent_type === "ghost"), "ghost member is unresolved");

	const mapped = profileToDetachedGraphStart(resolved, { objective: "x", task: "x" });
	assert.equal(mapped.graph, undefined, "unresolved member blocks the start graph");
	assert.ok(mapped.diagnostics.some((d) => d.severity === "error"));
});

test("profile wiring: a missing profile name returns a lookup diagnostic", () => {
	const cwd = fixture();
	const lookup = findProfile("does-not-exist", { invocationCwd: cwd });
	assert.equal(lookup.profile, undefined);
});
