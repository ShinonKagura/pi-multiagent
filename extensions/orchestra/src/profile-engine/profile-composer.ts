/** Layer 2: Profile Engine — profile composition.
 *
 * Pure composition from a loaded ProfileDefinition plus a caller-provided
 * Layer-1 persona lookup. This module does not build `agent_team` graphs or
 * launch children; runtime wiring remains Layer 3.
 */

import type { Persona } from "../agent-registry/types.ts";
import type { PersonaLookupFn, ProfileAgentSpec, ProfileDefinition, ProfileDiagnostic, ResolvedProfile, ResolvedProfileAgent, UnresolvedProfileAgent } from "./types.ts";

export function resolveProfile(profile: ProfileDefinition, lookupPersona: PersonaLookupFn): ResolvedProfile {
	const agents: ResolvedProfileAgent[] = [];
	const unresolvedAgents: UnresolvedProfileAgent[] = [];
	const diagnostics: ProfileDiagnostic[] = [];

	for (const profileAgent of profile.agents) {
		const persona = lookupPersona(profileAgent.subagent_type);
		if (!persona) {
			const diagnostic: ProfileDiagnostic = {
				code: "profile-persona-not-found",
				message: `Profile agent ${JSON.stringify(profileAgent.subagent_type)} did not resolve to a persona.`,
				path: profile.sourcePath,
				severity: "error",
			};
			diagnostics.push(diagnostic);
			unresolvedAgents.push({ profileAgent, subagent_type: profileAgent.subagent_type, diagnostic });
			continue;
		}
		agents.push(resolveProfileAgent(profile, profileAgent, persona));
	}

	return { profile, name: profile.name, kind: profile.kind, agents, unresolvedAgents, diagnostics };
}

function resolveProfileAgent(profile: ProfileDefinition, profileAgent: ProfileAgentSpec, persona: Persona): ResolvedProfileAgent {
	const frontmatter = persona.frontmatter;
	return {
		profileAgent,
		persona,
		subagent_type: profileAgent.subagent_type,
		model: profileAgent.model ?? frontmatter.model,
		fallbackModels: copyList(profileAgent.fallbackModels ?? frontmatter.fallbackModels),
		thinking: profileAgent.thinking ?? frontmatter.thinking,
		tools: copyList(profileAgent.tools ?? frontmatter.tools),
		inherit_context: profileAgent.inherit_context ?? frontmatter.inheritProjectContext,
		inheritSkills: frontmatter.inheritSkills,
		defaultContext: frontmatter.defaultContext,
		max_turns: profileAgent.max_turns,
		systemPrompt: composeSystemPrompt(persona, profile.sharedSystemPrompt),
	};
}

function composeSystemPrompt(persona: Persona, sharedSystemPrompt: string): string {
	const personaPrompt = persona.systemPrompt.trim();
	const shared = sharedSystemPrompt.trim();
	if (!shared) return personaPrompt;
	if (!personaPrompt) return shared;
	return `${personaPrompt}\n---\n${shared}`;
}

function copyList(value: string[] | undefined): string[] | undefined {
	return value ? [...value] : undefined;
}
