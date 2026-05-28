/** Layer 1: Agent Registry — persona loader.
 *
 * Reads `.pi/agents/<name>.md` from the four search paths (see types.ts),
 * parses YAML frontmatter, and returns a normalized Persona.
 *
 * v0.5 SCOPE: discovery + parse. No model resolution, no profile composition.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Persona, PersonaDiscoveryInput, PersonaFrontmatter, PersonaLookup } from "./types.ts";
import { PERSONA_SEARCH_PATHS } from "./types.ts";

/** Parse the YAML frontmatter block at the top of a markdown file. */
function parseFrontmatter(raw: string): { frontmatter: PersonaFrontmatter; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
	if (!match) {
		// No frontmatter -> persona with body only (best-effort).
		return { frontmatter: { name: "" }, body: raw };
	}
	const [, frontmatterBlock, body] = match;
	const fm: PersonaFrontmatter = { name: "" };
	for (const rawLine of frontmatterBlock.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		const m = /^([A-Za-z][A-Za-z0-9_-]*): *(.*)$/.exec(line);
		if (!m) continue;
		const [, key, value] = m;
		const trimmedValue = value.trim();
		// Heuristic: list-shape if starts with [ or contains commas.
		if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
			const inner = trimmedValue.slice(1, -1).trim();
			(fm as Record<string, unknown>)[key] = inner ? inner.split(",").map((v) => unquote(v.trim())) : [];
		} else if (key === "tools" || key === "fallbackModels" || key === "tags" || key === "extensions") {
			(fm as Record<string, unknown>)[key] = trimmedValue ? trimmedValue.split(",").map((v) => unquote(v.trim())) : [];
		} else if (trimmedValue === "true" || trimmedValue === "false") {
			(fm as Record<string, unknown>)[key] = trimmedValue === "true";
		} else {
			(fm as Record<string, unknown>)[key] = unquote(trimmedValue);
		}
	}
	return { frontmatter: fm, body: body ?? "" };
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Try to load the persona file at `path`. Returns undefined if missing/unreadable.
 * Caller assigns the source priority.
 */
function tryLoadPersonaFile(path: string): { frontmatter: PersonaFrontmatter; body: string } | undefined {
	try {
		const raw = readFileSync(path, "utf8");
		return parseFrontmatter(raw);
	} catch {
		return undefined;
	}
}

/**
 * Discover persona by exact name across the 4 search paths. First match wins.
 *
 * `name` lookup is case-insensitive (after normalization).
 */
export function findPersona(name: string, input: PersonaDiscoveryInput): PersonaLookup {
	const normalized = name.trim().toLowerCase();
	if (!normalized) {
		return { persona: undefined, diagnostic: "persona name is empty" };
	}
	const homeDir = input.userHomeDir ?? homedir();
	const candidateBaseDirs = PERSONA_SEARCH_PATHS.map((p) => {
		const base = p.scope === "invocation" ? input.invocationCwd : p.scope === "home" ? homeDir : (input.builtinAgentDir ?? "");
		return { dir: base ? join(base, p.relative) : "", source: p.source };
	});
	for (const { dir, source } of candidateBaseDirs) {
		if (!dir) continue;
		// Try exact filename match first; then case-insensitive scan would be added later.
		const candidatePath = join(dir, `${name}.md`);
		const loaded = tryLoadPersonaFile(candidatePath);
		if (loaded) {
			// If the file omitted `name:`, fill it from the lookup key.
			const frontmatter: PersonaFrontmatter = { ...loaded.frontmatter, name: loaded.frontmatter.name || name };
			// Verify the file's declared name matches lookup (case-insensitive).
			if (frontmatter.name && frontmatter.name.toLowerCase() !== normalized) {
				// Mismatch — keep looking but record for diagnostics.
				continue;
			}
			const persona: Persona = { frontmatter, systemPrompt: loaded.body.trim(), sourcePath: candidatePath, source };
			return { persona, diagnostic: undefined };
		}
	}
	return { persona: undefined, diagnostic: `persona-not-found: ${name} (searched 4 paths from ${input.invocationCwd})` };
}

/**
 * v0.5 TODO (deferred to next slice):
 *   - listAllPersonas() — enumerate all discovered personas across the 4 paths
 *   - case-insensitive directory scan (currently exact filename match only)
 *   - fuzzy match (e.g. "reviewer" finds "coding_reviewer")
 *   - validate against PersonaFrontmatter shape contract
 */
