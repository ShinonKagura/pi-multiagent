// Quick smoke-test for Layer 1 agent-registry — uses Mark's stellar/.pi/agents/coding_reviewer.md
import { findPersona } from "/tmp/pi-multiagent-upstream/extensions/orchestra/src/agent-registry/persona-loader.ts";

const result = findPersona("coding_reviewer", { invocationCwd: "/mnt/DEV/stellar" });
console.log("=== findPersona('coding_reviewer') ===");
console.log("diagnostic:", result.diagnostic);
if (result.persona) {
	console.log("source:     ", result.persona.source);
	console.log("sourcePath: ", result.persona.sourcePath);
	console.log("frontmatter:");
	for (const [k, v] of Object.entries(result.persona.frontmatter)) {
		console.log(`  ${k}: ${JSON.stringify(v)}`);
	}
	console.log("systemPrompt-first-50:", result.persona.systemPrompt.slice(0, 50));
}

console.log("\n=== findPersona('does-not-exist') ===");
const r2 = findPersona("does-not-exist", { invocationCwd: "/mnt/DEV/stellar" });
console.log("diagnostic:", r2.diagnostic);
console.log("persona:", r2.persona);
