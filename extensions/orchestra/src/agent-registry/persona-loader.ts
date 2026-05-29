/** Layer 1: Agent Registry — persona loader.
 *
 * Reads `.pi/agents/<name>.md` from the four search paths (see types.ts),
 * parses YAML-like frontmatter, and returns normalized Persona records.
 *
 * v0.5 SCOPE: discovery + parse + catalog + lookup. No model resolution,
 * no profile composition, no execution-runtime wiring.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

import type { Persona, PersonaCatalog, PersonaDiagnostic, PersonaDiscoveryInput, PersonaFrontmatter, PersonaLookup, PersonaSearchDir, PersonaSource } from "./types.ts";
import { PERSONA_SEARCH_PATHS } from "./types.ts";

const ARRAY_FIELDS = new Set(["tools", "fallbackModels", "tags", "extensions"]);
const BOOLEAN_FIELDS = new Set(["inheritProjectContext", "inheritSkills"]);
const STRING_FIELDS = new Set(["schemaVersion", "name", "package", "description", "model", "thinking"]);
const SYSTEM_PROMPT_MODES = new Set(["append", "replace"]);
const DEFAULT_CONTEXTS = new Set(["fork", "clean"]);

/** Parse the YAML-like frontmatter block at the top of a markdown file. */
function parseFrontmatter(raw: string): { frontmatter: PersonaFrontmatter; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(raw);
	if (!match) {
		// No frontmatter -> persona with body only (best-effort). Caller fills name from filename/lookup.
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
		// Heuristic: list-shape if starts with [ or is one of the known comma-list fields.
		if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
			const inner = trimmedValue.slice(1, -1).trim();
			(fm as Record<string, unknown>)[key] = inner ? splitCommaList(inner) : [];
		} else if (ARRAY_FIELDS.has(key)) {
			(fm as Record<string, unknown>)[key] = trimmedValue ? splitCommaList(trimmedValue) : [];
		} else if (trimmedValue === "true" || trimmedValue === "false") {
			(fm as Record<string, unknown>)[key] = trimmedValue === "true";
		} else {
			(fm as Record<string, unknown>)[key] = unquote(trimmedValue);
		}
	}
	return { frontmatter: fm, body: body ?? "" };
}

function splitCommaList(value: string): string[] {
	return value.split(",").map((v) => unquote(v.trim())).filter(Boolean);
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
 * Discover persona by name across the 4 search paths. Lookup is case-insensitive.
 * If no exact/case-insensitive match exists, a unique fuzzy match is accepted.
 */
export function findPersona(name: string, input: PersonaDiscoveryInput): PersonaLookup {
	const normalized = normalizeName(name);
	if (!normalized) {
		return { persona: undefined, diagnostic: "persona name is empty" };
	}

	const diagnostics: PersonaDiagnostic[] = [];
	for (const { dir, source } of candidateBaseDirs(input)) {
		if (!dir) continue;
		const matchPath = findCaseInsensitivePersonaPath(dir, name);
		if (!matchPath) continue;
		const persona = loadPersona(matchPath, source, basenameWithoutMarkdown(matchPath), diagnostics, normalized);
		if (persona) return { persona, diagnostic: undefined };
	}

	const catalog = listAllPersonas(input);
	const fuzzyMatches = catalog.personas
		.map((persona) => ({ persona, score: fuzzyScore(normalized, persona.frontmatter.name), sourceRank: sourceRank(persona.source) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.sourceRank - right.sourceRank || left.persona.frontmatter.name.localeCompare(right.persona.frontmatter.name));

	if (fuzzyMatches.length > 0) {
		const [best, second] = fuzzyMatches;
		if (!second || best.score > second.score || best.sourceRank < second.sourceRank) return { persona: best.persona, diagnostic: undefined };
		const suggestions = fuzzyMatches.slice(0, 5).map((entry) => entry.persona.frontmatter.name).join(", ");
		return { persona: undefined, diagnostic: `persona-not-found: ${name}; fuzzy match is ambiguous (${suggestions})` };
	}

	const suggestions = nearestPersonaNames(normalized, catalog.personas).join(", ");
	const suffix = suggestions ? `; did you mean: ${suggestions}?` : "";
	return { persona: undefined, diagnostic: `persona-not-found: ${name} (searched 4 paths from ${input.invocationCwd})${suffix}` };
}

/** Enumerate all discoverable personas across the 4 search paths. First source wins. */
export function listAllPersonas(input: PersonaDiscoveryInput): PersonaCatalog {
	const diagnostics: PersonaDiagnostic[] = [];
	const searchedDirs = candidateBaseDirs(input).filter((entry) => entry.dir.length > 0);
	const byName = new Map<string, Persona>();

	for (const { dir, source } of searchedDirs) {
		for (const filePath of listPersonaMarkdownFiles(dir, diagnostics)) {
			const fallbackName = basenameWithoutMarkdown(filePath);
			const persona = loadPersona(filePath, source, fallbackName, diagnostics);
			if (!persona) continue;
			const key = normalizeName(persona.frontmatter.name);
			if (!byName.has(key)) byName.set(key, persona);
		}
	}

	return {
		personas: Array.from(byName.values()).sort((left, right) => left.frontmatter.name.localeCompare(right.frontmatter.name)),
		diagnostics,
		searchedDirs,
	};
}

function candidateBaseDirs(input: PersonaDiscoveryInput): PersonaSearchDir[] {
	const homeDir = input.userHomeDir ?? homedir();
	return PERSONA_SEARCH_PATHS.map((p) => {
		const base = p.scope === "invocation" ? input.invocationCwd : p.scope === "home" ? homeDir : (input.builtinAgentDir ?? "");
		return { dir: base ? join(base, p.relative) : "", source: p.source };
	});
}

function findCaseInsensitivePersonaPath(dir: string, requestedName: string): string | undefined {
	const exactPath = join(dir, `${requestedName}.md`);
	if (existsSync(exactPath)) return exactPath;

	const normalized = normalizeName(requestedName);
	for (const filePath of listPersonaMarkdownFiles(dir, [])) {
		if (normalizeName(basenameWithoutMarkdown(filePath)) === normalized) return filePath;
	}
	return undefined;
}

function listPersonaMarkdownFiles(dir: string, diagnostics: PersonaDiagnostic[]): string[] {
	if (!existsSync(dir)) return [];
	try {
		if (!statSync(dir).isDirectory()) {
			diagnostics.push({ code: "persona-dir-not-directory", message: "Persona search path is not a directory.", path: dir, severity: "warning" });
			return [];
		}
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
			.map((entry) => join(dir, entry.name))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		diagnostics.push({ code: "persona-dir-unreadable", message: `Could not read persona directory: ${String(error)}`, path: dir, severity: "warning" });
		return [];
	}
}

function loadPersona(filePath: string, source: PersonaSource, fallbackName: string, diagnostics: PersonaDiagnostic[], expectedLookupName?: string): Persona | undefined {
	const loaded = tryLoadPersonaFile(filePath);
	if (!loaded) {
		diagnostics.push({ code: "persona-file-unreadable", message: "Could not read persona file.", path: filePath, severity: "warning" });
		return undefined;
	}
	const frontmatter: PersonaFrontmatter = { ...loaded.frontmatter, name: loaded.frontmatter.name || fallbackName };
	const shapeDiagnostic = validateFrontmatter(frontmatter, filePath);
	if (shapeDiagnostic) {
		diagnostics.push(shapeDiagnostic);
		return undefined;
	}
	if (expectedLookupName && normalizeName(frontmatter.name) !== expectedLookupName) {
		diagnostics.push({
			code: "persona-name-mismatch",
			message: `Persona file declares name ${JSON.stringify(frontmatter.name)} but lookup expected ${JSON.stringify(expectedLookupName)}.`,
			path: filePath,
			severity: "warning",
		});
		return undefined;
	}
	return { frontmatter, systemPrompt: loaded.body.trim(), sourcePath: filePath, source };
}

function validateFrontmatter(frontmatter: PersonaFrontmatter, path: string): PersonaDiagnostic | undefined {
	if (typeof frontmatter.name !== "string" || frontmatter.name.trim() === "") {
		return { code: "persona-name-invalid", message: "Persona frontmatter requires a non-empty string name.", path, severity: "error" };
	}
	for (const field of STRING_FIELDS) {
		const value = frontmatter[field];
		if (value !== undefined && typeof value !== "string") return invalidField(path, field, "a string");
	}
	for (const field of ARRAY_FIELDS) {
		const value = frontmatter[field];
		if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) return invalidField(path, field, "a string array");
	}
	for (const field of BOOLEAN_FIELDS) {
		const value = frontmatter[field];
		if (value !== undefined && typeof value !== "boolean") return invalidField(path, field, "a boolean");
	}
	if (frontmatter.systemPromptMode !== undefined && !SYSTEM_PROMPT_MODES.has(String(frontmatter.systemPromptMode))) return invalidField(path, "systemPromptMode", "append or replace");
	if (frontmatter.defaultContext !== undefined && !DEFAULT_CONTEXTS.has(String(frontmatter.defaultContext))) return invalidField(path, "defaultContext", "fork or clean");
	return undefined;
}

function invalidField(path: string, field: string, expected: string): PersonaDiagnostic {
	return { code: "persona-frontmatter-invalid", message: `Persona frontmatter field ${field} must be ${expected}.`, path, severity: "error" };
}

function basenameWithoutMarkdown(filePath: string): string {
	const base = basename(filePath);
	return extname(base).toLowerCase() === ".md" ? base.slice(0, -3) : base;
}

function normalizeName(name: string): string {
	return name.trim().toLowerCase();
}

function sourceRank(source: PersonaSource): number {
	switch (source) {
		case "project": return 0;
		case "workspace": return 1;
		case "user": return 2;
		case "builtin": return 3;
	}
}

function fuzzyScore(query: string, personaName: string): number {
	const name = normalizeName(personaName);
	if (!query || !name) return 0;
	if (name === query) return 100;
	const parts = name.split(/[^a-z0-9]+/).filter(Boolean);
	if (parts.includes(query)) return 90;
	if (name.includes(query)) return 70;
	if (isSubsequence(query, name)) return 40;
	return 0;
}

function isSubsequence(query: string, value: string): boolean {
	let index = 0;
	for (const char of value) {
		if (char === query[index]) index += 1;
		if (index === query.length) return true;
	}
	return false;
}

function nearestPersonaNames(query: string, personas: Persona[]): string[] {
	return personas
		.map((persona) => ({ name: persona.frontmatter.name, distance: levenshtein(query, normalizeName(persona.frontmatter.name)) }))
		.sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
		.slice(0, 3)
		.map((entry) => entry.name);
}

function levenshtein(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i += 1) {
		let prevDiagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= right.length; j += 1) {
			const old = previous[j];
			previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, prevDiagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
			prevDiagonal = old;
		}
	}
	return previous[right.length];
}
