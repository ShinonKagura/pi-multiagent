/** Shared graph authority normalization and policy derivation. */

import type { ExtensionToolPolicy, GraphAuthority } from "./types.ts";
import { MUTATION_CHILD_TOOL_NAMES, READONLY_CHILD_TOOL_NAMES, SHELL_CHILD_TOOL_NAMES, type BuiltinChildToolName } from "./types.ts";

export type BuiltinToolAuthorityKind = "filesystem-read" | "shell" | "mutation";

export const GRAPH_AUTHORITY_KEYS: readonly (keyof GraphAuthority)[] = [
	"allowFilesystemRead",
	"allowShellTools",
	"allowMutationTools",
	"allowExtensionCode",
	"allowProjectCode",
	"allowMutationWorktree",
];

export const BUILTIN_TOOL_AUTHORITY_MATRIX: readonly { kind: BuiltinToolAuthorityKind; tools: readonly BuiltinChildToolName[]; authority: keyof GraphAuthority }[] = [
	{ kind: "filesystem-read", tools: READONLY_CHILD_TOOL_NAMES, authority: "allowFilesystemRead" },
	{ kind: "shell", tools: SHELL_CHILD_TOOL_NAMES, authority: "allowShellTools" },
	{ kind: "mutation", tools: MUTATION_CHILD_TOOL_NAMES, authority: "allowMutationTools" },
];

export function normalizeAuthority(authority: Partial<GraphAuthority> | undefined): GraphAuthority {
	return {
		allowFilesystemRead: authority?.allowFilesystemRead ?? false,
		allowShellTools: authority?.allowShellTools ?? false,
		allowMutationTools: authority?.allowMutationTools ?? false,
		allowExtensionCode: authority?.allowExtensionCode ?? false,
		allowProjectCode: authority?.allowProjectCode ?? false,
		allowMutationWorktree: authority?.allowMutationWorktree ?? false,
	};
}

export function extensionToolPolicyFromAuthority(authority: GraphAuthority): ExtensionToolPolicy {
	const projectCodePolicy = authority.allowProjectCode ? "allow" : "deny";
	return { projectExtensions: projectCodePolicy, localExtensions: projectCodePolicy };
}

export function builtinToolAuthority(tool: string): keyof GraphAuthority | undefined {
	for (const row of BUILTIN_TOOL_AUTHORITY_MATRIX) if (row.tools.some((candidate) => candidate === tool)) return row.authority;
	return undefined;
}

export function builtinToolAllowedByAuthority(tool: string, authority: GraphAuthority): boolean {
	const key = builtinToolAuthority(tool);
	return key === undefined || authority[key];
}
