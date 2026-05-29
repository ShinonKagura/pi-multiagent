/** Node --loader that maps the Pi peer package + its siblings to concrete files for the test runner.
 *
 * The Pi runtime (`@earendil-works/pi-coding-agent`) is a peer dependency, and its sibling deps
 * (`pi-tui`, `pi-ai`, `typebox`) live in different places depending on the install layout:
 *   - a clean local/CI install (pnpm) HOISTS typebox/pi-tui to the top-level node_modules;
 *   - a flat global npm install NESTS them under the peer's own node_modules.
 *
 * So we resolve each specifier in two passes: first via normal Node resolution from the fork root
 * (handles pnpm/CI + package "exports"), then via the legacy nested path under the peer root
 * (handles the flat global install). The peer root itself prefers an explicit override, then the
 * local fork install, then the global npm root.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const forkRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function resolvePiCodingAgentEntry() {
	const candidates = [];
	if (process.env.PI_CODING_AGENT_PACKAGE_ROOT) candidates.push(process.env.PI_CODING_AGENT_PACKAGE_ROOT);
	candidates.push(join(forkRoot, "node_modules", "@earendil-works", "pi-coding-agent"));
	try {
		const globalRoot = execFileSync("npm", ["--silent", "root", "-g"], { encoding: "utf8" }).trim();
		if (globalRoot) candidates.push(join(globalRoot, "@earendil-works", "pi-coding-agent"));
	} catch {
		/* npm not on PATH; rely on the local/override candidates */
	}
	for (const root of candidates) {
		const entry = join(root, "dist", "index.js");
		if (existsSync(entry)) return entry;
	}
	return join(forkRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
}

/** Pick the first resolvable candidate: absolute file paths are existence-checked, bare specifiers go
 * through Node resolution (which honors pnpm hoisting + package exports). */
function pick(...candidates) {
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (candidate.startsWith("/") || /^[A-Za-z]:\\/.test(candidate)) {
			if (existsSync(candidate)) return candidate;
			continue;
		}
		try {
			return require.resolve(candidate);
		} catch {
			/* try the next candidate */
		}
	}
	return undefined;
}

const peerEntry = resolvePiCodingAgentEntry();
const peerRoot = dirname(dirname(peerEntry));

const MAPPINGS = new Map([["@earendil-works/pi-coding-agent", peerEntry]]);
for (const [specifier, ...candidates] of [
	["@earendil-works/pi-tui", "@earendil-works/pi-tui", join(peerRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js")],
	["@earendil-works/pi-ai", "@earendil-works/pi-ai", join(peerRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")],
	["typebox", "typebox", join(peerRoot, "node_modules", "typebox", "build", "index.mjs")],
	["typebox/compile", "typebox/compile", join(peerRoot, "node_modules", "typebox", "build", "compile", "index.mjs")],
]) {
	const resolved = pick(...candidates);
	if (resolved) MAPPINGS.set(specifier, resolved);
}

export async function resolve(specifier, context, nextResolve) {
	const mapped = MAPPINGS.get(specifier);
	if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true };
	return nextResolve(specifier, context);
}
