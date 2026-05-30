/** Layer 4: Harness Contracts — public exports.
 *
 * Read-only discovery + validation of an optional project/workspace harness contract.
 * ARCHITECTURE I6: hb-orchestra reads harness files if present; it never writes them and never
 * claims authority over `.pi/harness/` or `.agents/harness/`.
 */

export type { HarnessContract, HarnessContractLookup, HarnessDiagnostic, HarnessDiscoveryInput, HarnessSource } from "./types.ts";
export { HARNESS_CONTRACT_FILENAMES, HARNESS_SEARCH_PATHS } from "./types.ts";
export { findHarnessContract, summarizeHarnessContract } from "./contract-loader.ts";
export type { HarnessApplication } from "./apply.ts";
export { applyContractToGraph, applyHarnessContract, buildHarnessPolicyText, forbiddenPathViolation, graphRequestsMutation } from "./apply.ts";
