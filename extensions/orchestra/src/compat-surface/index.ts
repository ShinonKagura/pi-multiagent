/** Layer 6: Compat Surface — public exports.
 *
 * v0.5 minimal: pure `Agent()` invocation -> detached single-step graph mapping.
 * Tool/slash-command registration and the `runAgentTeam` call live in
 * `extensions/orchestra/index.ts`.
 */

export type { AgentDetachedGraphResult, AgentInvocation } from "./types.ts";
export { agentInvocationToDetachedGraphStart } from "./agent-graph.ts";
