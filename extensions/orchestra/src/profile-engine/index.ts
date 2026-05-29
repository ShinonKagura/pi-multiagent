/** Layer 2: Profile Engine — public exports.
 *
 * Loads and validates saved `.pi/profiles/<name>.{json|md}` workflow profiles.
 * Composition into executable detached graphs is intentionally Layer 3.
 */

export type { PersonaLookupFn, ProfileAgentSpec, ProfileCatalog, ProfileDefinition, ProfileDiagnostic, ProfileDiscoveryInput, ProfileFrontmatter, ProfileKind, ProfileLookup, ProfileSearchDir, ProfileSource, ResolvedProfile, ResolvedProfileAgent, UnresolvedProfileAgent } from "./types.ts";
export { PROFILE_SEARCH_PATHS } from "./types.ts";
export { findProfile, listAllProfiles } from "./profile-loader.ts";
export { resolveProfile } from "./profile-composer.ts";
