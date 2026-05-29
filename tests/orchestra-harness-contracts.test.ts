/** Layer 4 (harness-contracts) tests.
 *
 * Scope: read-only discovery + validation of an optional `.pi/harness/` (project) or
 * `.agents/harness/` (workspace) contract. ARCHITECTURE I6: hb-orchestra reads, never writes.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findHarnessContract, summarizeHarnessContract } from "../extensions/orchestra/src/harness-contracts/index.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "hb-orchestra-harness-"));
}

function writeContract(cwd: string, relativeDir: string, body: string): void {
	const dir = join(cwd, relativeDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "contract.json"), body, "utf8");
}

const VALID = JSON.stringify({
	mutationAllowed: false,
	mutationScope: "none",
	allowedPaths: ["src/**"],
	forbiddenPaths: [".pi/**"],
	approvalGateRequired: true,
	reviewGateRequired: true,
	systemPromptFiles: ["policies/rules.md"],
	planPacketPath: "templates/plan-packet.yaml",
});

test("findHarnessContract: loads a project .pi/harness contract", () => {
	const cwd = tmp();
	writeContract(cwd, ".pi/harness", VALID);
	const lookup = findHarnessContract({ invocationCwd: cwd });
	assert.ok(lookup.contract, "contract loads");
	assert.equal(lookup.contract?.source, "project");
	assert.equal(lookup.contract?.mutationAllowed, false);
	assert.equal(lookup.contract?.mutationScope, "none");
	assert.deepEqual(lookup.contract?.allowedPaths, ["src/**"]);
	assert.equal(lookup.contract?.approvalGateRequired, true);
	assert.deepEqual(lookup.contract?.systemPromptFiles, ["policies/rules.md"]);
	assert.equal(lookup.contract?.planPacketPath, "templates/plan-packet.yaml");
	assert.equal(lookup.diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("findHarnessContract: falls back to workspace .agents/harness", () => {
	const cwd = tmp();
	writeContract(cwd, ".agents/harness", VALID);
	const lookup = findHarnessContract({ invocationCwd: cwd });
	assert.ok(lookup.contract);
	assert.equal(lookup.contract?.source, "workspace");
});

test("findHarnessContract: project .pi/harness wins over workspace .agents/harness", () => {
	const cwd = tmp();
	writeContract(cwd, ".pi/harness", JSON.stringify({ mutationScope: "project-scope" }));
	writeContract(cwd, ".agents/harness", JSON.stringify({ mutationScope: "workspace-scope" }));
	const lookup = findHarnessContract({ invocationCwd: cwd });
	assert.equal(lookup.contract?.source, "project");
	assert.equal(lookup.contract?.mutationScope, "project-scope");
});

test("findHarnessContract: absent harness is not an error (optional)", () => {
	const cwd = tmp();
	const lookup = findHarnessContract({ invocationCwd: cwd });
	assert.equal(lookup.contract, undefined);
	assert.equal(lookup.diagnostics.filter((d) => d.severity === "error").length, 0);
	assert.ok(lookup.searchedDirs.length >= 2);
});

test("findHarnessContract: unparseable JSON yields an error diagnostic and no contract", () => {
	const cwd = tmp();
	writeContract(cwd, ".pi/harness", "{ not valid json ");
	const lookup = findHarnessContract({ invocationCwd: cwd });
	assert.equal(lookup.contract, undefined);
	assert.ok(lookup.diagnostics.some((d) => d.code === "harness-contract-unparseable" && d.severity === "error"));
});

test("findHarnessContract: a wrong-typed field warns but keeps the rest of the contract", () => {
	const cwd = tmp();
	writeContract(cwd, ".pi/harness", JSON.stringify({ mutationScope: 5, approvalGateRequired: true }));
	const lookup = findHarnessContract({ invocationCwd: cwd });
	assert.ok(lookup.contract, "contract still returned");
	assert.equal(lookup.contract?.mutationScope, undefined, "invalid field omitted");
	assert.equal(lookup.contract?.approvalGateRequired, true, "valid field kept");
	assert.ok(lookup.diagnostics.some((d) => d.code === "harness-contract-field-invalid" && d.severity === "warning"));
});

test("summarizeHarnessContract: readable summaries for present and absent contracts", () => {
	const cwd = tmp();
	assert.match(summarizeHarnessContract(findHarnessContract({ invocationCwd: cwd })), /No harness contract found/);
	writeContract(cwd, ".pi/harness", VALID);
	assert.match(summarizeHarnessContract(findHarnessContract({ invocationCwd: cwd })), /Harness contract \(project\)/);
});
