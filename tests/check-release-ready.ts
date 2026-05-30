import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = readPackageJson();
const changelog = readFileSync(join(packageRoot, "CHANGELOG.md"), "utf8");

assert.equal(packageJson.name, "hb-orchestra", "release guard is scoped to hb-orchestra");
assert.equal(packageJson.private, undefined, "package must not be private");
assert.equal(typeof packageJson.version, "string", "package.json version must be a string");
assert.match(packageJson.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/, "package.json version must be semver-shaped");
assert.equal(typeof packageJson.packageManager, "string", "package.json must record packageManager for release reproducibility");
assert.equal(isRecord(packageJson.engines) && typeof packageJson.engines.node === "string", true, "package.json must record supported Node engine");
assert.equal(isRecord(packageJson.publishConfig) && packageJson.publishConfig.access === "public", true, "package.json publishConfig.access must be public");
const headPackageJson = readHeadPackageJson();
assert.equal(headPackageJson.name, packageJson.name, "HEAD package.json package name must match the working release package");
assert.equal(headPackageJson.version, packageJson.version, "HEAD package.json version must match the working release version; commit intended release files before publish");
assert.equal(gitStdout(["status", "--porcelain"]).trim(), "", "release source tree must be clean; commit intended changes before publish");

const unreleased = sectionBody(changelog, "Unreleased");
assert.equal(unreleased.trim(), "", "CHANGELOG.md Unreleased must be empty before npm publish");
const releaseHeading = releaseHeadingForVersion(changelog, packageJson.version);
assert.ok(releaseHeading, `CHANGELOG.md must contain a release heading for ${packageJson.version}`);
assert.match(releaseHeading, new RegExp(`^## ${escapeRegExp(packageJson.version)} - [0-9]{4}-[0-9]{2}-[0-9]{2}$`), "current release heading must include an ISO date");
assert.match(sectionBody(changelog, releaseHeading.slice(3)), /^- /m, "current changelog release section must contain bullet entries");

const versions = npmPublishedVersions(packageJson.name);
assert.equal(versions.includes(packageJson.version), false, `${packageJson.name}@${packageJson.version} already exists on npm`);

function readPackageJson(): Record<string, unknown> {
	const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	if (!isRecord(parsed)) throw new Error("package.json must parse to an object");
	return parsed;
}

function readHeadPackageJson(): Record<string, unknown> {
	const parsed: unknown = JSON.parse(gitStdout(["show", "HEAD:package.json"]));
	if (!isRecord(parsed)) throw new Error("HEAD:package.json must parse to an object");
	return parsed;
}

function gitStdout(args: string[]): string {
	const result = spawnSync("git", args, { cwd: packageRoot, encoding: "utf8" });
	if (result.stderr.length > 0) process.stderr.write(result.stderr);
	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
	return result.stdout;
}

function npmPublishedVersions(name: unknown): string[] {
	assert.equal(typeof name, "string", "package name must be a string before npm lookup");
	const result = spawnSync("npm", ["view", name, "versions", "--json"], { cwd: packageRoot, encoding: "utf8" });
	if (result.stderr.length > 0) process.stderr.write(result.stderr);
	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
	const parsed: unknown = JSON.parse(result.stdout);
	assert.equal(Array.isArray(parsed), true, "npm view versions must return an array");
	return parsed.filter((value): value is string => typeof value === "string");
}

function sectionBody(markdown: string, heading: string): string {
	const marker = heading.startsWith("## ") ? heading : `## ${heading}`;
	const start = markdown.indexOf(marker);
	assert.equal(start >= 0, true, `missing changelog section ${marker}`);
	const bodyStart = markdown.indexOf("\n", start);
	if (bodyStart === -1) return "";
	const next = markdown.indexOf("\n## ", bodyStart + 1);
	return markdown.slice(bodyStart + 1, next === -1 ? markdown.length : next);
}

function releaseHeadingForVersion(markdown: string, version: string): string {
	const pattern = new RegExp(`^## ${escapeRegExp(version)} - [^\n]+$`, "m");
	return markdown.match(pattern)?.[0] ?? "";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
