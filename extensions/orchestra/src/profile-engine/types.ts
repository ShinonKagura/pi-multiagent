/** Layer 2: Profile Engine — contracts.
 *
 * v0.5 scope: load and validate saved profile definitions from
 * `.pi/profiles/<name>.{json|md}`. Composition into executable `agent_team`
 * graphs is Layer 3 and intentionally absent here.
 */

import type { Persona } from "../agent-registry/types.ts";

export type ProfileKind = "chain" | "parallel";

export interface ProfileAgentSpec {
	/** pi-subagents-compatible persona/agent key. Resolved by Layer 1. */
	subagent_type: string;
	/** Optional explicit model override for this profile step. */
	model?: string;
	/** Optional fallback model chain captured for later Layer 2 composition policy. */
	fallbackModels?: string[];
	/** Optional thinking budget hint: off | minimal | low | medium | high | xhigh | inherit. */
	thinking?: string;
	/** Optional strict child tool allowlist. */
	tools?: string[];
	/** Optional context inheritance override for Agent()-compatible profile calls. */
	inherit_context?: boolean;
	/** Optional bounded-turn hint for Agent()-compatible profile calls. */
	max_turns?: number;
	/** Catch-all for future profile metadata; validation preserves unknown fields. */
	[key: string]: unknown;
}

export interface ProfileFrontmatter {
	/** Profile execution shape. */
	kind: ProfileKind;
	/** Ordered profile members. Chain preserves order; parallel runs all members from same input. */
	agents: ProfileAgentSpec[];
	/** Optional explicit display name. When omitted, filename basename is used. */
	name?: string;
	/** Optional description for future catalog rendering. */
	description?: string;
	/** Optional tags for future catalog/search. */
	tags?: string[];
	/** Catch-all for future profile metadata; validation preserves unknown fields. */
	[key: string]: unknown;
}

export interface ProfileDefinition {
	name: string;
	kind: ProfileKind;
	agents: ProfileAgentSpec[];
	/** Markdown body after frontmatter, or JSON `sharedSystemPrompt`. */
	sharedSystemPrompt: string;
	frontmatter: ProfileFrontmatter;
	sourcePath: string;
	source: ProfileSource;
}

export type ProfileSource = "project";

export interface ProfileDiagnostic {
	code: string;
	message: string;
	path?: string;
	severity: "warning" | "error";
}

export interface ProfileDiscoveryInput {
	invocationCwd: string;
}

export interface ProfileCatalog {
	profiles: ProfileDefinition[];
	diagnostics: ProfileDiagnostic[];
	searchedDirs: ProfileSearchDir[];
}

export interface ProfileSearchDir {
	dir: string;
	source: ProfileSource;
}

export interface ProfileLookup {
	profile: ProfileDefinition | undefined;
	diagnostic: string | undefined;
}

export interface ResolvedProfileAgent {
	/** Original profile agent spec after validation. */
	profileAgent: ProfileAgentSpec;
	/** Layer 1 persona snapshot used for this resolved agent. */
	persona: Persona;
	subagent_type: string;
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	tools?: string[];
	inherit_context?: boolean;
	inheritSkills?: boolean;
	defaultContext?: "fork" | "clean";
	max_turns?: number;
	/** Final composed system prompt for this profile member. */
	systemPrompt: string;
}

export interface UnresolvedProfileAgent {
	profileAgent: ProfileAgentSpec;
	subagent_type: string;
	diagnostic: ProfileDiagnostic;
}

export interface ResolvedProfile {
	profile: ProfileDefinition;
	name: string;
	kind: ProfileKind;
	agents: ResolvedProfileAgent[];
	unresolvedAgents: UnresolvedProfileAgent[];
	diagnostics: ProfileDiagnostic[];
}

export type PersonaLookupFn = (subagentType: string) => Persona | undefined;

/** v0.5 profile search path. Project-only by design; user/workspace profile catalogs are deferred until there is a concrete precedence requirement. */
export const PROFILE_SEARCH_PATHS = [
	{ relative: ".pi/profiles", source: "project" as const, scope: "invocation" as const },
] as const;
