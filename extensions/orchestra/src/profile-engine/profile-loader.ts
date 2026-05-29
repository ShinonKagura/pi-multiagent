/** Layer 2: Profile Engine — profile loader.
 *
 * Loads `.pi/profiles/<name>.{json|md}` and validates the v0.5 profile
 * contract. This layer does not resolve personas or build executable graphs;
 * runtime wiring remains Layer 3.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

import type { ProfileAgentSpec, ProfileCatalog, ProfileDefinition, ProfileDiagnostic, ProfileDiscoveryInput, ProfileFrontmatter, ProfileKind, ProfileLookup, ProfileSearchDir, ProfileSource } from "./types.ts";
import { PROFILE_SEARCH_PATHS } from "./types.ts";

const ARRAY_FIELDS = new Set(["tools", "fallbackModels", "tags"]);
const BOOLEAN_FIELDS = new Set(["inherit_context"]);
const NUMBER_FIELDS = new Set(["max_turns"]);
const PROFILE_KINDS = new Set<ProfileKind>(["chain", "parallel"]);

export function findProfile(name: string, input: ProfileDiscoveryInput): ProfileLookup {
	const normalized = normalizeName(name);
	if (!normalized) return { profile: undefined, diagnostic: "profile name is empty" };
	for (const { dir, source } of candidateBaseDirs(input)) {
		const filePath = findCaseInsensitiveProfilePath(dir, name);
		if (!filePath) continue;
		const diagnostics: ProfileDiagnostic[] = [];
		const profile = loadProfile(filePath, source, basenameWithoutProfileExtension(filePath), diagnostics, normalized);
		if (profile) return { profile, diagnostic: undefined };
		const diagnostic = diagnostics.find((item) => item.severity === "error") ?? diagnostics[0];
		return { profile: undefined, diagnostic: diagnostic?.message ?? `profile-invalid: ${name}` };
	}
	return { profile: undefined, diagnostic: `profile-not-found: ${name} (searched ${candidateBaseDirs(input).length} paths from ${input.invocationCwd})` };
}

export function listAllProfiles(input: ProfileDiscoveryInput): ProfileCatalog {
	const diagnostics: ProfileDiagnostic[] = [];
	const searchedDirs = candidateBaseDirs(input).filter((entry) => entry.dir.length > 0);
	const profiles: ProfileDefinition[] = [];
	for (const { dir, source } of searchedDirs) {
		for (const filePath of listProfileFiles(dir, diagnostics)) {
			const profile = loadProfile(filePath, source, basenameWithoutProfileExtension(filePath), diagnostics);
			if (profile) profiles.push(profile);
		}
	}
	return { profiles: profiles.sort((left, right) => left.name.localeCompare(right.name)), diagnostics, searchedDirs };
}

function candidateBaseDirs(input: ProfileDiscoveryInput): ProfileSearchDir[] {
	return PROFILE_SEARCH_PATHS.map((p) => ({ dir: join(input.invocationCwd, p.relative), source: p.source }));
}

function findCaseInsensitiveProfilePath(dir: string, requestedName: string): string | undefined {
	const jsonPath = join(dir, `${requestedName}.json`);
	if (existsSync(jsonPath)) return jsonPath;
	const mdPath = join(dir, `${requestedName}.md`);
	if (existsSync(mdPath)) return mdPath;
	const normalized = normalizeName(requestedName);
	for (const filePath of listProfileFiles(dir, [])) {
		if (normalizeName(basenameWithoutProfileExtension(filePath)) === normalized) return filePath;
	}
	return undefined;
}

function listProfileFiles(dir: string, diagnostics: ProfileDiagnostic[]): string[] {
	if (!existsSync(dir)) return [];
	try {
		if (!statSync(dir).isDirectory()) {
			diagnostics.push({ code: "profile-dir-not-directory", message: "Profile search path is not a directory.", path: dir, severity: "warning" });
			return [];
		}
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && isProfileFile(entry.name))
			.map((entry) => join(dir, entry.name))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		diagnostics.push({ code: "profile-dir-unreadable", message: `Could not read profile directory: ${String(error)}`, path: dir, severity: "warning" });
		return [];
	}
}

function loadProfile(filePath: string, source: ProfileSource, fallbackName: string, diagnostics: ProfileDiagnostic[], expectedLookupName?: string): ProfileDefinition | undefined {
	let loaded: { frontmatter: ProfileFrontmatter; body: string };
	try {
		loaded = filePath.toLowerCase().endsWith(".json") ? parseJsonProfile(readFileSync(filePath, "utf8")) : parseMarkdownProfile(readFileSync(filePath, "utf8"));
	} catch (error) {
		diagnostics.push({ code: "profile-file-invalid", message: `Could not parse profile file: ${String(error)}`, path: filePath, severity: "error" });
		return undefined;
	}
	const frontmatter: ProfileFrontmatter = { ...loaded.frontmatter, name: loaded.frontmatter.name || fallbackName };
	const shapeDiagnostic = validateProfileFrontmatter(frontmatter, filePath);
	if (shapeDiagnostic) {
		diagnostics.push(shapeDiagnostic);
		return undefined;
	}
	const profileName = frontmatter.name ?? fallbackName;
	if (expectedLookupName && normalizeName(profileName) !== expectedLookupName) {
		diagnostics.push({ code: "profile-name-mismatch", message: `Profile declares name ${JSON.stringify(profileName)} but lookup expected ${JSON.stringify(expectedLookupName)}.`, path: filePath, severity: "warning" });
		return undefined;
	}
	return {
		name: profileName,
		kind: frontmatter.kind,
		agents: frontmatter.agents,
		sharedSystemPrompt: loaded.body.trim(),
		frontmatter,
		sourcePath: filePath,
		source,
	};
}

function parseJsonProfile(raw: string): { frontmatter: ProfileFrontmatter; body: string } {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const sharedSystemPrompt = typeof parsed.sharedSystemPrompt === "string" ? parsed.sharedSystemPrompt : "";
	const { sharedSystemPrompt: _ignored, ...frontmatter } = parsed;
	return { frontmatter: frontmatter as unknown as ProfileFrontmatter, body: sharedSystemPrompt };
}

function parseMarkdownProfile(raw: string): { frontmatter: ProfileFrontmatter; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(raw);
	if (!match) throw new Error("profile markdown requires frontmatter");
	const [, block, body] = match;
	return { frontmatter: parseProfileYamlSubset(block), body: body ?? "" };
}

function parseProfileYamlSubset(block: string): ProfileFrontmatter {
	const result: Record<string, unknown> = {};
	let currentAgent: Record<string, unknown> | undefined;
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;
		if (line === "agents:") {
			result.agents = [];
			currentAgent = undefined;
			continue;
		}
		const item = /^\s*-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
		if (item) {
			currentAgent = {};
			((result.agents ??= []) as Record<string, unknown>[]).push(currentAgent);
			assignYamlScalar(currentAgent, item[1], item[2]);
			continue;
		}
		const nested = /^\s{2,}([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
		if (nested && currentAgent) {
			assignYamlScalar(currentAgent, nested[1], nested[2]);
			continue;
		}
		const scalar = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
		if (scalar) assignYamlScalar(result, scalar[1], scalar[2]);
	}
	return result as unknown as ProfileFrontmatter;
}

function assignYamlScalar(target: Record<string, unknown>, key: string, value: string): void {
	const trimmed = value.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1).trim();
		target[key] = inner ? splitCommaList(inner) : [];
	} else if (ARRAY_FIELDS.has(key)) {
		target[key] = trimmed ? splitCommaList(trimmed) : [];
	} else if (BOOLEAN_FIELDS.has(key)) {
		target[key] = trimmed === "true" ? true : trimmed === "false" ? false : trimmed;
	} else if (NUMBER_FIELDS.has(key)) {
		const parsed = Number(trimmed);
		target[key] = Number.isFinite(parsed) ? parsed : trimmed;
	} else {
		target[key] = unquote(trimmed);
	}
}

function splitCommaList(value: string): string[] {
	return value.split(",").map((item) => unquote(item.trim())).filter(Boolean);
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
	return value;
}

function validateProfileFrontmatter(frontmatter: ProfileFrontmatter, path: string): ProfileDiagnostic | undefined {
	if (!PROFILE_KINDS.has(frontmatter.kind)) return invalidField(path, "kind", "chain or parallel");
	if (!Array.isArray(frontmatter.agents) || frontmatter.agents.length === 0) return invalidField(path, "agents", "a non-empty agent list");
	for (const [index, agent] of frontmatter.agents.entries()) {
		const prefix = `agents[${index}]`;
		if (!isRecord(agent)) return invalidField(path, prefix, "an object");
		if (typeof agent.subagent_type !== "string" || agent.subagent_type.trim() === "") return invalidField(path, `${prefix}.subagent_type`, "a non-empty string");
		const diagnostic = validateProfileAgent(agent, path, prefix);
		if (diagnostic) return diagnostic;
	}
	if (frontmatter.name !== undefined && typeof frontmatter.name !== "string") return invalidField(path, "name", "a string");
	if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") return invalidField(path, "description", "a string");
	if (frontmatter.tags !== undefined && (!Array.isArray(frontmatter.tags) || frontmatter.tags.some((item) => typeof item !== "string"))) return invalidField(path, "tags", "a string array");
	return undefined;
}

function validateProfileAgent(agent: ProfileAgentSpec, path: string, prefix: string): ProfileDiagnostic | undefined {
	for (const field of ["model", "thinking"] as const) {
		if (agent[field] !== undefined && typeof agent[field] !== "string") return invalidField(path, `${prefix}.${field}`, "a string");
	}
	for (const field of ["tools", "fallbackModels"] as const) {
		if (agent[field] !== undefined && (!Array.isArray(agent[field]) || agent[field]?.some((item) => typeof item !== "string"))) return invalidField(path, `${prefix}.${field}`, "a string array");
	}
	if (agent.inherit_context !== undefined && typeof agent.inherit_context !== "boolean") return invalidField(path, `${prefix}.inherit_context`, "a boolean");
	if (agent.max_turns !== undefined && (!Number.isInteger(agent.max_turns) || agent.max_turns < 1)) return invalidField(path, `${prefix}.max_turns`, "a positive integer");
	return undefined;
}

function invalidField(path: string, field: string, expected: string): ProfileDiagnostic {
	return { code: "profile-frontmatter-invalid", message: `Profile field ${field} must be ${expected}.`, path, severity: "error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfileFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".json") || lower.endsWith(".md");
}

function basenameWithoutProfileExtension(filePath: string): string {
	const base = basename(filePath);
	const ext = extname(base).toLowerCase();
	return ext === ".json" || ext === ".md" ? base.slice(0, -ext.length) : base;
}

function normalizeName(name: string): string {
	return name.trim().toLowerCase();
}
