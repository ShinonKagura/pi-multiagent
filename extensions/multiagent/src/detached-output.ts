/** Final-output helpers for detached runs. */

import type { RunStatus, StepArtifactReference, StepOutput, StepStatus, TeamStepSpec, WorktreeTeardownEvidence } from "./types.ts";

export const FINAL_INLINE_PREVIEW_CHARS = 6000;

interface StepFinalArtifactInput {
	runId: string;
	objective: string;
	step: TeamStepSpec;
	status: StepStatus;
	startedAt: string | undefined;
	endedAt: string;
	text: string;
	assistantFinals: string[];
	nonFinalText: string | undefined;
	stopReason: string | undefined;
	upstreamArtifacts: StepArtifactReference[];
	worktree?: WorktreeTeardownEvidence;
}

export function buildStepFinalArtifact(input: StepFinalArtifactInput): string {
	const sections: string[] = [
		"# agent_team step final",
		"",
		`runId: ${input.runId}`,
		`objective: ${input.objective}`,
		`stepId: ${input.step.id}`,
		`status: ${input.status}`,
		`stopReason: ${input.stopReason ?? input.status}`,
		`agentRef: ${input.step.agent.ref}`,
		`agentSource: ${input.step.agent.source}`,
		`model: ${input.step.agent.model ?? "inherit"}`,
		`thinking: ${input.step.agent.thinking ?? "inherit"}`,
		`effectiveTools: ${input.step.agent.tools.length > 0 ? input.step.agent.tools.join(", ") : "none"}`,
		`extensionTools: ${input.step.agent.extensionTools.length > 0 ? input.step.agent.extensionTools.map((tool) => tool.name).join(", ") : "none"}`,
		`mutationScope: ${input.step.mutationScope ?? "none"}`,
		`isolation: ${input.step.isolation ?? "none"}`,
		`cwd: ${input.step.cwd ?? "default"}`,
		`needs: ${input.step.needs.length > 0 ? input.step.needs.join(", ") : "none"}`,
		`after: ${input.step.after.length > 0 ? input.step.after.join(", ") : "none"}`,
		`startedAt: ${input.startedAt ?? ""}`,
		`endedAt: ${input.endedAt}`,
		"",
		"## Upstream artifacts",
		formatUpstreamArtifacts(input.upstreamArtifacts),
	];
	if (input.worktree) {
		sections.push("", "## Worktree isolation evidence", formatWorktreeEvidence(input.worktree));
	}
	sections.push("", "## Task", "", input.step.task, "", formatStepFinalBody(input.text, input.assistantFinals, input.nonFinalText));
	return sections.join("\n");
}

function formatWorktreeEvidence(evidence: WorktreeTeardownEvidence): string {
	const lines: string[] = [
		`branch: ${evidence.branchName}`,
		`baseCommit: ${evidence.baseCommit}`,
		`patchPath: ${evidence.patchPath ?? "none (no mutations recorded)"}`,
		`diffStat:`,
		evidence.diffStat ? evidence.diffStat : "  (no diff)",
	];
	if (evidence.cleanupWarnings.length > 0) {
		lines.push(`cleanupWarnings:`);
		for (const warning of evidence.cleanupWarnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}

function formatUpstreamArtifacts(upstreamArtifacts: StepArtifactReference[]): string {
	if (upstreamArtifacts.length === 0) return "none";
	return upstreamArtifacts.map((artifact) => {
		const path = artifact.filePath ? JSON.stringify(artifact.filePath) : "none";
		const chars = artifact.chars ?? 0;
		return `- ${artifact.stepId} [${artifact.status}]: artifact=${path} chars=${chars}`;
	}).join("\n");
}

function formatStepFinalBody(text: string, assistantFinals: string[], nonFinalText: string | undefined): string {
	if (assistantFinals.length === 1) return assistantFinals[0] ?? "";
	if (assistantFinals.length > 1) return formatAssistantFinalMessages(assistantFinals);
	if (nonFinalText !== undefined && nonFinalText.trim().length > 0) return formatNonFinalText(nonFinalText);
	return fallbackFinalText(text);
}

export function formatAssistantFinalMessages(texts: string[]): string {
	return texts.map((text, index) => [`## Assistant final ${index + 1}`, "", text].join("\n")).join("\n\n");
}

export function formatNonFinalText(text: string): string {
	return ["## Non-final assistant evidence", "", "This text was captured before a successful assistant final. It is retained as bounded failure/cancel/timeout evidence, not as a completed child answer.", "", text].join("\n");
}

function fallbackFinalText(text: string): string {
	return ["## Final text", "", text].join("\n");
}

export function boundedFinalPreview(text: string): string {
	if (text.length <= FINAL_INLINE_PREVIEW_CHARS) return text;
	return `${text.slice(0, FINAL_INLINE_PREVIEW_CHARS)}\n\n[agent_team preview truncated; full final is in the artifact file.]`;
}

export function boundedTextPreview(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const suffix = "\n\n[agent_team preview truncated by maxBytes.]";
	const budget = Math.max(1, maxBytes - Buffer.byteLength(suffix, "utf8"));
	return `${utf8Prefix(text, budget)}${suffix}`;
}

export function boundedStepOutput(output: StepOutput, maxBytes: number): StepOutput {
	if (output.text === undefined) return output;
	return { ...output, text: boundedTextPreview(output.text, maxBytes) };
}

function utf8Prefix(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		const next = Buffer.byteLength(char, "utf8");
		if (bytes + next > maxBytes) break;
		bytes += next;
		end += char.length;
	}
	return text.slice(0, end);
}

export function isTerminalStepStatus(status: StepStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "blocked" || status === "timed_out" || status === "canceled";
}

export function isTerminalRunStatus(status: RunStatus): boolean {
	return status === "succeeded" || status === "mixed" || status === "failed" || status === "canceled" || status === "expired";
}
