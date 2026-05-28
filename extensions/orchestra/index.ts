/**
 * hb-orchestra extension entry-point.
 *
 * v0.5.0-pre: scaffold only. Inherited agent_team tool continues to be
 * registered by `./extensions/multiagent/index.ts`. As layers land, they
 * register additional tools/commands/events here:
 *
 *   - Layer 6 (compat-surface): Agent, get_subagent_result, steer_subagent tools
 *   - Layer 6 (compat-surface): /agent, /profile, /agents slash commands
 *   - Layer 5 (reproducibility-ledger): hb-orchestra:run-* events + replay tool
 *   - Layer 4 (harness-contracts): optional .pi/harness/ reader on spawn
 *
 * For v0.5.0-pre this file is a deliberate no-op so the package loads cleanly
 * without altering inherited behaviour.
 */

import type { PiContext } from "@earendil-works/pi-coding-agent";

export async function activate(_pi: PiContext): Promise<void> {
	// Intentional no-op for v0.5.0-pre. Inherited multiagent/index.ts handles
	// agent_team registration. Orchestra layers land in follow-up commits.
}

export async function deactivate(): Promise<void> {
	// No-op.
}
