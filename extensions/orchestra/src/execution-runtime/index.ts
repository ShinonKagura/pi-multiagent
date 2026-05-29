/** Layer 3: Execution Runtime — public exports.
 *
 * Maps hb-orchestra profiles to inherited detached `agent_team` start graphs.
 */

export type { ProfileDetachedGraphOptions, ProfileDetachedGraphResult } from "./types.ts";
export { profileToDetachedGraphStart } from "./profile-graph.ts";
