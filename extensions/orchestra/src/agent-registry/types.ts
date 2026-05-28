/** Layer 1: Agent Registry — types. */

/**
 * Persona frontmatter parsed from `.pi/agents/<name>.md`.
 * Compatible with pi-subagents 0.24.2 / @tintinweb/pi-subagents 0.7.3 / stellar/.pi/agents/.
 */
export interface PersonaFrontmatter {
	/**
	 * Optional explicit schema version of this persona record.
	 * When omitted, hb-orchestra assumes the v0.5 implicit schema described in
	 * ARCHITECTURE.md §I3. Future breaking schema changes will bump this value
	 * and remain back-compat at parse time.
	 */
	schemaVersion?: string;
	/** Agent name; matches the file basename. Case-insensitive lookups allowed. */
	name: string;
	/** Optional grouping ("coding", "review", "research", ...). */
	package?: string;
	/** One-line description for catalog display. */
	description?: string;
	/** Free-form tags for search/filter. */
	tags?: string[];
	/**
	 * Primary model id (`<provider>/<model>`, e.g. `anthropic/claude-sonnet-4-5`).
	 * When omitted, child inherits parent's model.
	 */
	model?: string;
	/**
	 * Ordered fallback chain when `model` provider is unavailable.
	 * Resolution at run-time (v0.7) — v0.5 captures the list only.
	 */
	fallbackModels?: string[];
	/** Thinking budget hint: off | minimal | low | medium | high | xhigh | inherit. */
	thinking?: string;
	/** Explicit child tool allowlist. Replaces catalog defaults if set. */
	tools?: string[];
	/** systemPromptMode: append | replace. */
	systemPromptMode?: "append" | "replace";
	/** When true, fork the parent conversation into the child as starting context. */
	inheritProjectContext?: boolean;
	/** When true, propagate caller-visible skills into the child. */
	inheritSkills?: boolean;
	/** Initial context policy: fork (inherit) | clean (fresh). */
	defaultContext?: "fork" | "clean";
	/** Extensions to load alongside the agent (Stellar pattern, optional). */
	extensions?: string[];
	/** Catch-all for additional frontmatter fields we want to preserve verbatim. */
	[key: string]: unknown;
}

/**
 * Fully-resolved persona definition (frontmatter + body + source provenance).
 */
export interface Persona {
	frontmatter: PersonaFrontmatter;
	/** System-prompt body (markdown after the frontmatter block). */
	systemPrompt: string;
	/** Filesystem source path; useful for diagnostics. */
	sourcePath: string;
	/** Source priority: project | workspace | user | builtin. Determines override order. */
	source: PersonaSource;
}

export type PersonaSource = "project" | "workspace" | "user" | "builtin";

/**
 * Result of a persona lookup. `notFound` returns an empty `persona` and a `diagnostic`.
 */
export interface PersonaLookup {
	persona: Persona | undefined;
	diagnostic: string | undefined;
}

/**
 * Inputs to persona discovery. `invocationCwd` decides which `.pi/agents/` is "project".
 */
export interface PersonaDiscoveryInput {
	invocationCwd: string;
	userHomeDir?: string;
	builtinAgentDir?: string;
}

/**
 * Search hierarchy (in this order; first match wins):
 *
 *   1. `<invocationCwd>/.pi/agents/<name>.md`              -> source: "project"
 *   2. `<invocationCwd>/.agents/agents/<name>.md`          -> source: "workspace"
 *   3. `<userHomeDir>/.pi/agent/agents/<name>.md`          -> source: "user"
 *   4. `<builtinAgentDir>/<name>.md`                       -> source: "builtin"
 */
export const PERSONA_SEARCH_PATHS = [
	{ relative: ".pi/agents", source: "project" as const, scope: "invocation" as const },
	{ relative: ".agents/agents", source: "workspace" as const, scope: "invocation" as const },
	{ relative: ".pi/agent/agents", source: "user" as const, scope: "home" as const },
	{ relative: "", source: "builtin" as const, scope: "builtin" as const },
] as const;
