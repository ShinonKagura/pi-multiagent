/** Layer 1: Agent Registry — public exports.
 *
 * This module reads persona definitions from `.pi/agents/<name>.md` files
 * across the 4 search paths (project, workspace, user, builtin) and returns
 * normalized `Persona` records ready for the Profile Engine (Layer 2).
 *
 * v0.5 status: skeleton + parse + exact-name lookup.
 *
 * Out of scope for this layer:
 *   - profile composition (chain/parallel) — Layer 2
 *   - runtime model fallback resolution — Layer 2
 *   - tool authority normalization — Layer 2/3 boundary
 *   - run manifest writing — Layer 5
 */

export type { Persona, PersonaFrontmatter, PersonaLookup, PersonaSource, PersonaDiscoveryInput } from "./types.ts";
export { PERSONA_SEARCH_PATHS } from "./types.ts";
export { findPersona } from "./persona-loader.ts";
