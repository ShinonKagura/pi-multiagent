/** Step final artifact materialization for detached run terminal evidence. */

import { writeRunArtifact, type RunArtifactStore } from "./background-artifacts.ts";
import type { BackgroundEventStore } from "./background-events.ts";
import { boundedFinalPreview, buildStepFinalArtifact, formatAssistantFinalMessages, formatNonFinalText } from "./detached-output.ts";
import type { StepState } from "./detached-state.ts";
import { recordRuntimeDiagnostic } from "./runtime-diagnostics.ts";
import type { AgentDiagnostic, StepArtifactReference, StepOutput, StepStatus, WorktreeTeardownEvidence } from "./types.ts";

export function createStepOutputArtifact(input: { runId: string; objective: string; artifactStore: RunArtifactStore; diagnostics: AgentDiagnostic[]; events: BackgroundEventStore; state: StepState; status: StepStatus; text: string; assistantFinals?: string[]; nonFinalText?: string; stopReason?: string; upstreamArtifacts?: StepArtifactReference[]; worktree?: WorktreeTeardownEvidence }): StepOutput {
	const assistantFinals = input.assistantFinals ?? [];
	const outputText = outputTextForStep(input.text, assistantFinals, input.nonFinalText);
	const content = buildStepFinalArtifact({ runId: input.runId, objective: input.objective, step: input.state.spec, status: input.status, startedAt: input.state.startedAt, endedAt: now(), text: input.text, assistantFinals, nonFinalText: input.nonFinalText, stopReason: input.stopReason, upstreamArtifacts: input.upstreamArtifacts ?? [], worktree: input.worktree });
	try {
		const record = writeRunArtifact(input.artifactStore, `${input.state.spec.id}-final.md`, `step-final:${input.state.spec.id}`, content);
		return { stepId: input.state.spec.id, status: input.status, text: boundedFinalPreview(outputText), filePath: record.path, chars: outputText.length };
	} catch (error) {
		const message = `Could not write final artifact for ${input.state.spec.id}: ${error instanceof Error ? error.message : String(error)}`;
		recordRuntimeDiagnostic(input.diagnostics, input.events, "step-final-artifact-failed", "artifact", message);
		return { stepId: input.state.spec.id, status: input.status, text: boundedFinalPreview(outputText), filePath: undefined, chars: outputText.length };
	}
}

function outputTextForStep(text: string, assistantFinals: string[], nonFinalText: string | undefined): string {
	if (assistantFinals.length > 0) return assistantFinals.length === 1 ? assistantFinals[0] ?? "" : formatAssistantFinalMessages(assistantFinals);
	if (text.trim().length > 0) return text;
	return nonFinalText ? formatNonFinalText(nonFinalText) : text;
}

function now(): string {
	return new Date().toISOString();
}
