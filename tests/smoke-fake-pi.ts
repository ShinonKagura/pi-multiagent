import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerMultiagentExtension } from "../extensions/multiagent/index.ts";
import type { SpawnOptions } from "../extensions/multiagent/src/child-launch.ts";
import type { AgentTeamDetails } from "../extensions/multiagent/src/types.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

interface RegisteredTool {
	name: string;
	execute: (toolCallId: string, params: object, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionCtx) => Promise<{ content: { type: string; text: string }[]; details: AgentTeamDetails }>;
}

interface ExtensionCtx {
	cwd: string;
	hasUI: boolean;
	model: undefined;
	sessionManager: { getSessionId: () => string };
	ui: {
		confirm: () => Promise<boolean>;
		setWidget: (id: string, value: unknown) => void;
		setStatus: (id: string, value: string | undefined) => void;
	};
}

type ShutdownHandler = (event: { reason?: string }, ctx: ExtensionCtx) => void | Promise<void>;

class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	pid: number | undefined = undefined;
	onKill: (() => void) | undefined;

	kill(): boolean {
		this.onKill?.();
		return true;
	}

	close(code: number): void {
		this.exitCode = code;
		this.emit("close", code, null);
		this.stdout.end();
		this.stderr.end();
	}
}

const tools: RegisteredTool[] = [];
const flagValues = new Map<string, boolean | string>();
const customMessages: { message: unknown; options: unknown }[] = [];
const footerStatusWrites: { sessionId: string; id: string; value: string | undefined }[] = [];
const widgetValues: unknown[] = [];
const uiEvents: { sessionId: string; kind: "widget"; value: unknown }[] = [];
const delayedNoticeChildren: FakeChild[] = [];
const tasks: string[] = [];
const shutdownHandlers: ShutdownHandler[] = [];

registerMultiagentExtension(
	{
		on(eventName: string, handler: ShutdownHandler) {
			if (eventName === "session_shutdown") shutdownHandlers.push(handler);
		},
		registerMessageRenderer() {},
		registerFlag(name: string, options: { default?: boolean | string }) {
			if (options.default !== undefined) flagValues.set(name, options.default);
		},
		getFlag(name: string) {
			return flagValues.get(name);
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		sendMessage(message: unknown, options: unknown) {
			customMessages.push({ message, options });
		},
		getThinkingLevel() {
			return undefined;
		},
		getActiveTools() {
			return ["read"];
		},
		getAllTools() {
			return [];
		},
		getCommands() {
			return [];
		},
	},
	{ spawnProcess },
);

const tool = tools.find((candidate) => candidate.name === "agent_team");
assert.ok(tool);
assert.equal(flagValues.get("agent-team-subagent-skills"), "auto");

const catalog = await tool.execute("smoke-catalog", { action: "catalog", library: { sources: ["package"], query: "review" } }, undefined, undefined, makeCtx(false));
assert.equal(catalog.content[0].text.includes("package:reviewer"), true);

const invalidCatalogControl = await tool.execute("smoke-invalid-catalog-control", { action: "catalog", maxBytes: 1000 }, undefined, undefined, makeCtx(false));
assert.equal(invalidCatalogControl.content[0].text.startsWith("# agent_team error"), true);
assert.match(invalidCatalogControl.content[0].text, /library\.query/);
assert.doesNotMatch(invalidCatalogControl.content[0].text, /^# agent_team catalog/);

let confirmed = false;
const invalidRun = await tool.execute("smoke-invalid-run", { action: "run" }, undefined, undefined, makeCtx(true, () => {
	confirmed = true;
	return Promise.resolve(true);
}));
assert.equal(confirmed, false);
assert.equal(invalidRun.content[0].text.startsWith("# agent_team error"), true);
assert.equal(invalidRun.content[0].text.includes("action-invalid"), true);

const started = await tool.execute(
	"smoke-start",
	{ action: "start", graph: { objective: "smoke run", authority: { allowFilesystemRead: true }, steps: [{ id: "step", agent: { system: "Return smoke-ok." }, task: "smoke task" }], limits: { timeoutSecondsPerStep: 30 } }, options: { terminalRetentionSeconds: 30, notify: { mode: "milestones", minIntervalSeconds: 0 } } },
	undefined,
	undefined,
	makeCtx(true),
);
const runId = started.details.run?.runId ?? "";
assert.match(runId, /^r[1-9][0-9]{0,6}$/);
assert.equal(runId.length <= 8, true);
assert.equal(started.details.run?.terminal, false);

let terminal = await tool.execute("smoke-run_status-0", { action: "run_status", runId, preview: true }, undefined, undefined, makeCtx(true));
for (let attempt = 0; !terminal.details.run?.terminal && attempt < 20; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	terminal = await tool.execute(`smoke-run_status-${attempt + 1}`, { action: "run_status", runId, cursor: terminal.details.cursor, preview: true }, undefined, undefined, makeCtx(true));
}
assert.equal(terminal.details.run?.status, "succeeded");
assert.equal(terminal.details.steps[0]?.status, "succeeded");
assert.equal(terminal.details.events.length, 0);
assert.equal(terminal.details.outputs[0]?.filePath !== undefined, true);
assert.equal(terminal.content[0].text.includes("smoke-ok"), true);

const step_result = await tool.execute("smoke-step_result", { action: "step_result", runId, stepId: "step", preview: true }, undefined, undefined, makeCtx(true));
assert.equal(step_result.details.outputs[0]?.text, "smoke-ok");
assert.equal(tasks[0]?.includes("smoke task"), true);
assert.equal(customMessages.length, 1);
assertNotice(customMessages[0]);
assert.equal(footerStatusWrites.length, 0);
assert.equal(widgetValues.some((value) => value !== undefined), true);

const cleanup = await tool.execute("smoke-cleanup", { action: "cleanup", runId }, undefined, undefined, makeCtx(true));
assert.equal(cleanup.details.cleanup?.runId, runId);

const graphFileRoot = await mkdir(join(tmpdir(), `pi-multiagent-smoke-graph-file-${Date.now()}`), { recursive: true });
await writeFile(join(graphFileRoot, "graph.json"), JSON.stringify({ objective: "smoke graphFile", authority: { allowFilesystemRead: true }, steps: [{ id: "from-file", agent: { system: "Return smoke-ok." }, task: "graph file task" }], limits: { timeoutSecondsPerStep: 30 } }));
const graphFileStarted = await tool.execute("smoke-graph-file-start", { action: "start", graphFile: "graph.json", options: { terminalRetentionSeconds: 30, notify: { mode: "none" } } }, undefined, undefined, makeCtx(true, async () => false, graphFileRoot));
const graphFileRunId = graphFileStarted.details.run?.runId ?? "";
assert.match(graphFileRunId, /^r[1-9][0-9]{0,6}$/);
assert.notEqual(graphFileRunId, runId);
let graphFileTerminal = await tool.execute("smoke-graph-file-run_status-0", { action: "run_status", runId: graphFileRunId, preview: true }, undefined, undefined, makeCtx(true, async () => false, graphFileRoot));
for (let attempt = 0; !graphFileTerminal.details.run?.terminal && attempt < 20; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	graphFileTerminal = await tool.execute(`smoke-graph-file-run_status-${attempt + 1}`, { action: "run_status", runId: graphFileRunId, cursor: graphFileTerminal.details.cursor, preview: true }, undefined, undefined, makeCtx(true, async () => false, graphFileRoot));
}
assert.equal(graphFileTerminal.details.run?.status, "succeeded");
assert.equal(graphFileTerminal.details.outputs[0]?.text, "smoke-ok");
const graphFileCleanup = await tool.execute("smoke-graph-file-cleanup", { action: "cleanup", runId: graphFileRunId }, undefined, undefined, makeCtx(true, async () => false, graphFileRoot));
assert.equal(graphFileCleanup.details.cleanup?.runId, graphFileRunId);
await rm(graphFileRoot, { recursive: true, force: true });

const holdStarted = await tool.execute(
	"smoke-start-hold",
	{ action: "start", graph: { objective: "shutdown smoke", authority: { allowFilesystemRead: true }, steps: [{ id: "hold", agent: { system: "Wait until canceled." }, task: "hold task" }], limits: { timeoutSecondsPerStep: 30 } }, options: { terminalRetentionSeconds: 30, notify: { mode: "none" } } },
	undefined,
	undefined,
	makeCtx(true),
);
const holdRunId = holdStarted.details.run?.runId ?? "";
assert.match(holdRunId, /^r[1-9][0-9]{0,6}$/);
assert.notEqual(holdRunId, graphFileRunId);
assert.equal(holdStarted.details.run?.status, "running");
assert.equal(shutdownHandlers.length, 1);
const otherUiEventStart = uiEvents.length;
const otherHoldStarted = await tool.execute(
	"smoke-start-other-session-hold",
	{ action: "start", graph: { objective: "other session smoke", authority: { allowFilesystemRead: true }, steps: [{ id: "hold", agent: { system: "Wait until canceled." }, task: "other hold task" }], limits: { timeoutSecondsPerStep: 30 } }, options: { terminalRetentionSeconds: 30, notify: { mode: "none" } } },
	undefined,
	undefined,
	makeCtx(true, async () => false, packageRoot, "other-session"),
);
const otherHoldRunId = otherHoldStarted.details.run?.runId ?? "";
assert.match(otherHoldRunId, /^r[1-9][0-9]{0,6}$/);
assert.notEqual(otherHoldRunId, holdRunId);
const otherWidgetText = await waitForSessionWidgetTextAfter("other-session", otherUiEventStart, /other session smoke/);
assert.match(otherWidgetText, /other session smoke/);
assert.doesNotMatch(otherWidgetText, /shutdown smoke|2 runs/);
await shutdownHandlers[0]({ reason: "other session" }, makeCtx(true, async () => false, packageRoot, "other-session"));
let otherCanceled = await tool.execute("smoke-run_status-other-hold-0", { action: "run_status", runId: otherHoldRunId }, undefined, undefined, makeCtx(true, async () => false, packageRoot, "other-session"));
for (let attempt = 0; !otherCanceled.details.run?.terminal && attempt < 20; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	otherCanceled = await tool.execute(`smoke-run_status-other-hold-${attempt + 1}`, { action: "run_status", runId: otherHoldRunId, cursor: otherCanceled.details.cursor }, undefined, undefined, makeCtx(true, async () => false, packageRoot, "other-session"));
}
assert.equal(otherCanceled.details.run?.status, "canceled");
const otherHoldCleanup = await tool.execute("smoke-cleanup-other-hold", { action: "cleanup", runId: otherHoldRunId }, undefined, undefined, makeCtx(true, async () => false, packageRoot, "other-session"));
assert.equal(otherHoldCleanup.details.cleanup?.runId, otherHoldRunId);
const stillRunning = await tool.execute("smoke-run_status-hold-still-running", { action: "run_status", runId: holdRunId }, undefined, undefined, makeCtx(true, async () => false, packageRoot, "default-session"));
assert.equal(stillRunning.details.run?.status, "running");
await shutdownHandlers[0]({ reason: "smoke reload" }, makeCtx(true, async () => false, packageRoot, "default-session"));
let canceled = await tool.execute("smoke-run_status-hold-0", { action: "run_status", runId: holdRunId }, undefined, undefined, makeCtx(true));
for (let attempt = 0; !canceled.details.run?.terminal && attempt < 20; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	canceled = await tool.execute(`smoke-run_status-hold-${attempt + 1}`, { action: "run_status", runId: holdRunId, cursor: canceled.details.cursor }, undefined, undefined, makeCtx(true));
}
assert.equal(canceled.details.run?.status, "canceled");
assert.equal(canceled.details.steps[0]?.errorMessage?.includes("smoke reload"), true);
const holdCleanup = await tool.execute("smoke-cleanup-hold", { action: "cleanup", runId: holdRunId }, undefined, undefined, makeCtx(true));
assert.equal(holdCleanup.details.cleanup?.runId, holdRunId);

let activeNoticeSession = "notice-session-a";
const noticeCtx = () => makeCtx(true, async () => false, packageRoot, () => activeNoticeSession);
const customMessageCountBeforeInactiveNotice = customMessages.length;
const delayedNoticeStarted = await tool.execute(
	"smoke-start-delayed-notice",
	{ action: "start", graph: { objective: "inactive notice smoke", authority: { allowFilesystemRead: true }, steps: [{ id: "delayed", agent: { system: "Return notice-ok." }, task: "delayed notice task" }], limits: { timeoutSecondsPerStep: 30 } }, options: { terminalRetentionSeconds: 30, notify: { mode: "final" } } },
	undefined,
	undefined,
	noticeCtx(),
);
const delayedNoticeRunId = delayedNoticeStarted.details.run?.runId ?? "";
assert.match(delayedNoticeRunId, /^r[1-9][0-9]{0,6}$/);
activeNoticeSession = "notice-session-b";
finishDelayedNoticeChild("notice-ok");
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(customMessages.length, customMessageCountBeforeInactiveNotice);
activeNoticeSession = "notice-session-a";
const inactiveTerminalClearStart = uiEvents.length;
let delayedNoticeTerminal = await tool.execute("smoke-run_status-delayed-notice-0", { action: "run_status", runId: delayedNoticeRunId, preview: true }, undefined, undefined, noticeCtx());
for (let attempt = 0; !delayedNoticeTerminal.details.run?.terminal && attempt < 20; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	delayedNoticeTerminal = await tool.execute(`smoke-run_status-delayed-notice-${attempt + 1}`, { action: "run_status", runId: delayedNoticeRunId, cursor: delayedNoticeTerminal.details.cursor, preview: true }, undefined, undefined, noticeCtx());
}
assert.equal(delayedNoticeTerminal.details.run?.status, "succeeded");
assert.equal(delayedNoticeTerminal.details.outputs[0]?.text, "notice-ok");
assert.equal(uiEvents.slice(inactiveTerminalClearStart).some((event) => event.sessionId === "notice-session-a" && event.value === undefined), true);
assert.equal(footerStatusWrites.length, 0);
const delayedNoticeCleanup = await tool.execute("smoke-cleanup-delayed-notice", { action: "cleanup", runId: delayedNoticeRunId }, undefined, undefined, noticeCtx());
assert.equal(delayedNoticeCleanup.details.cleanup?.runId, delayedNoticeRunId);
const freshUiEventStart = uiEvents.length;
const freshStarted = await tool.execute(
	"smoke-start-fresh-after-inactive-terminal",
	{ action: "start", graph: { objective: "fresh notice session smoke", authority: { allowFilesystemRead: true }, steps: [{ id: "hold", agent: { system: "Wait until canceled." }, task: "fresh hold task" }], limits: { timeoutSecondsPerStep: 30 } }, options: { terminalRetentionSeconds: 30, notify: { mode: "none" } } },
	undefined,
	undefined,
	noticeCtx(),
);
const freshRunId = freshStarted.details.run?.runId ?? "";
assert.match(freshRunId, /^r[1-9][0-9]{0,6}$/);
const freshWidgetText = await waitForSessionWidgetTextAfter("notice-session-a", freshUiEventStart, /fresh notice session smoke/);
assert.match(freshWidgetText, /fresh notice session smoke/);
assert.equal(footerStatusWrites.length, 0);
await tool.execute("smoke-cancel-fresh-after-inactive-terminal", { action: "cancel", runId: freshRunId, reason: "fresh cleanup" }, undefined, undefined, noticeCtx());
let freshCanceled = await tool.execute("smoke-run_status-fresh-0", { action: "run_status", runId: freshRunId }, undefined, undefined, noticeCtx());
for (let attempt = 0; !freshCanceled.details.run?.terminal && attempt < 20; attempt += 1) {
	await new Promise((resolve) => setTimeout(resolve, 5));
	freshCanceled = await tool.execute(`smoke-run_status-fresh-${attempt + 1}`, { action: "run_status", runId: freshRunId, cursor: freshCanceled.details.cursor }, undefined, undefined, noticeCtx());
}
assert.equal(freshCanceled.details.run?.status, "canceled");
const freshCleanup = await tool.execute("smoke-cleanup-fresh-after-inactive-terminal", { action: "cleanup", runId: freshRunId }, undefined, undefined, noticeCtx());
assert.equal(freshCleanup.details.cleanup?.runId, freshRunId);
assert.equal(footerStatusWrites.length, 0);

function spawnProcess(_command: string, args: string[], spawnOptions: SpawnOptions): ChildProcessWithoutNullStreams {
	assert.equal(args.includes("smoke task"), false);
	assert.equal(spawnOptions.shell, false);
	assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
	assert.equal(args.includes("--mode"), true);
	assert.equal(args.includes("rpc"), true);
	assert.equal(args.includes("--no-session"), true);
	assert.equal(args.includes("--no-extensions"), false);
	assert.equal(args.includes("--no-context-files"), true);
	const child = new FakeChild();
	child.onKill = () => child.close(0);
	let buffer = "";
	child.stdin.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const command = JSON.parse(line) as { id: string; type: string; message?: string };
			if (command.message) tasks.push(command.message);
			child.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true })}\n`);
			if (command.type === "prompt" && command.message?.includes("delayed notice task") === true) {
				delayedNoticeChildren.push(child);
			} else if (command.type === "prompt" && command.message?.includes("hold task") !== true) {
				child.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "smoke-ok" }] } })}\n`);
				child.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [] })}\n`);
				child.close(0);
			}
			newline = buffer.indexOf("\n");
		}
	});
	return child as unknown as ChildProcessWithoutNullStreams;
}

function makeCtx(hasUI: boolean, confirm: () => Promise<boolean> = async () => false, cwd = packageRoot, sessionId: string | (() => string) = "default-session"): ExtensionCtx {
	const getSessionId = typeof sessionId === "function" ? sessionId : () => sessionId;
	return {
		cwd,
		hasUI,
		model: undefined,
		sessionManager: { getSessionId },
		ui: {
			confirm,
			setWidget(_id, value) {
				widgetValues.push(value);
				uiEvents.push({ sessionId: getSessionId(), kind: "widget", value });
			},
			setStatus(id, value) {
				footerStatusWrites.push({ sessionId: getSessionId(), id, value });
			},
		},
	};
}

function finishDelayedNoticeChild(text: string): void {
	const child = delayedNoticeChildren.shift();
	assert.ok(child);
	child.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`);
	child.stdout.write(`${JSON.stringify({ type: "agent_end", messages: [] })}\n`);
	child.close(0);
}

async function waitForSessionWidgetTextAfter(sessionId: string, afterIndex: number, expected: RegExp): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		for (const event of uiEvents.slice(afterIndex).reverse()) {
			if (event.sessionId !== sessionId) continue;
			const text = renderWidgetValue(event.value);
			if (expected.test(text)) return text;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return "";
}

function renderWidgetValue(value: unknown): string {
	if (typeof value !== "function") return "";
	const component = value({ requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text });
	return component.render(120).join("\n");
}

function assertNotice(notice: { message: unknown; options: unknown } | undefined): void {
	assert.ok(notice);
	assert.equal(isRecord(notice.options), true);
	assert.equal(notice.options.deliverAs, "steer");
	assert.equal(notice.options.triggerTurn, true);
	assert.equal(isRecord(notice.message), true);
	assert.equal(notice.message.customType, "agent_team.notice");
	assert.equal(notice.message.display, true);
	assert.equal(typeof notice.message.content, "string");
	assert.match(notice.message.content, /agent_team succeeded smoke run/);
	assert.match(notice.message.content, /runId=r[1-9][0-9]{0,6}/);
	assert.match(notice.message.content, /final evidence step succeeded .*\.md/);
	assert.match(notice.message.content, /untrusted status evidence; run_status\/step_result for artifacts/);
	assert.doesNotMatch(notice.message.content, /# agent_team terminal notice|Objective:|Run:|Exceptional controls|artifact=|Next:|cleanup|cursor|debugEvents|smoke-ok/i);
	assert.equal(isRecord(notice.message.details), true);
	const details = notice.message.details;
	const outputs = Array.isArray(details.outputs) ? details.outputs : [];
	const firstOutput = outputs.find(isRecord);
	assert.ok(firstOutput);
	assert.equal(firstOutput.text, undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
