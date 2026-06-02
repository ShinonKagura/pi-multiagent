import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ACK_TIMEOUT_MS, RpcChildController } from "../extensions/multiagent/src/rpc-child-controller.ts";
import type { SpawnOptions } from "../extensions/multiagent/src/child-launch.ts";
import type { RpcJsonRecord } from "../extensions/multiagent/src/rpc-jsonl.ts";
import type { RpcChildControllerOptions } from "../extensions/multiagent/src/rpc-child-types.ts";

let originalLauncher: string | undefined;
before(() => {
	// getPiInvocation resolves a launcher before the injected fake spawn runs; pin a resolvable one so
	// a clean CI runner without pi on PATH does not throw. The fake child is never actually executed.
	originalLauncher = process.env.PI_MULTIAGENT_PI_LAUNCHER;
	process.env.PI_MULTIAGENT_PI_LAUNCHER = process.execPath;
});
after(() => {
	if (originalLauncher === undefined) delete process.env.PI_MULTIAGENT_PI_LAUNCHER;
	else process.env.PI_MULTIAGENT_PI_LAUNCHER = originalLauncher;
});

test("prompt-accept ack window is generous enough for heavyweight child startup under load", () => {
	// run() sends `prompt` immediately after spawn with no readiness handshake, so this window must
	// cover full pi child startup (bootstrap + extension load + model-client init). A too-tight value
	// (the old 10s) caused uniform `RPC command prompt timed out waiting for response` failures with
	// chars=0 across healthy children under concurrent spawn load. Guard against re-tightening it.
	assert.ok(ACK_TIMEOUT_MS >= 60_000, `ACK_TIMEOUT_MS must be >= 60s for child startup under load; got ${ACK_TIMEOUT_MS}`);
});

class FakeRpcChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	readonly killSignals: NodeJS.Signals[] = [];
	private readonly behavior: "success" | "no-terminal";
	unrefCalls = 0;
	exitCode: number | null = null;
	pid: number | undefined = undefined;

	constructor(behavior: "success" | "no-terminal") {
		super();
		this.behavior = behavior;
		this.stdin = new Writable({
			write: (chunk, _encoding, callback) => {
				this.handleCommand(chunk.toString("utf8"));
				callback();
			},
		});
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		if (typeof signal === "string") this.killSignals.push(signal);
		this.closeIfNeeded();
		return true;
	}

	private handleCommand(line: string): void {
		const record = JSON.parse(line) as RpcJsonRecord;
		setImmediate(() => {
			this.writeRecord({ type: "response", id: record.id, command: record.type, success: true });
			if (this.behavior === "success" && record.type === "prompt") {
				this.writeRecord({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
				this.writeRecord({ type: "agent_end", stopReason: "stop" });
			}
		});
	}

	private writeRecord(record: RpcJsonRecord): void {
		this.stdout.write(`${JSON.stringify(record)}\n`);
	}

	private closeIfNeeded(): void {
		if (this.exitCode !== null) return;
		this.exitCode = 0;
		setImmediate(() => {
			this.emit("exit", 0, null);
			this.emit("close", 0, null);
		});
	}
}

function createOptions(child: FakeRpcChild, overrides: Partial<RpcChildControllerOptions> = {}): RpcChildControllerOptions {
	return {
		agent: {
			id: "one",
			ref: "inline:one",
			name: "one",
			kind: "inline",
			description: "one",
			tools: ["read", "grep", "find", "ls"],
			extensionTools: [],
			callerSkills: [],
			systemPrompt: "Return done.",
			model: undefined,
			thinking: undefined,
			source: "inline",
			filePath: undefined,
			sha256: undefined,
		},
		defaults: { model: undefined, thinking: undefined },
		limits: { timeoutSecondsPerStep: 30 },
		cwd: process.cwd(),
		promptPath: "/tmp/prompt.md",
		spawnProcess: (_command: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcessWithoutNullStreams,
		onEvent: () => undefined,
		...overrides,
	} as RpcChildControllerOptions;
}

test("RpcChildController unrefs detached child and normal terminal closeout still resolves", async () => {
	const child = new FakeRpcChild("success");
	const controller = new RpcChildController(createOptions(child));

	const result = await controller.run("do work");

	assert.equal(child.unrefCalls, 1);
	assert.equal(result.status, "succeeded");
	assert.equal(result.text, "done");
	assert.deepEqual(result.assistantFinals, ["done"]);
});

test("RpcChildController cancel path still terminates an unrefed child", async () => {
	const child = new FakeRpcChild("no-terminal");
	const controller = new RpcChildController(createOptions(child));
	const running = controller.run("wait");
	await new Promise((resolve) => setImmediate(resolve));

	controller.cancel("operator stop");
	const result = await running;

	assert.equal(child.unrefCalls, 1);
	assert.equal(result.status, "canceled");
	assert.equal(result.errorMessage, "operator stop");
	assert.ok(child.killSignals.includes("SIGTERM"));
});

test("RpcChildController timeout path still terminates an unrefed child", async () => {
	const child = new FakeRpcChild("no-terminal");
	const controller = new RpcChildController(createOptions(child, { limits: { timeoutSecondsPerStep: 0.01 } }));

	const result = await controller.run("wait forever");

	assert.equal(child.unrefCalls, 1);
	assert.equal(result.status, "timed_out");
	assert.match(result.errorMessage ?? "", /timeoutSecondsPerStep=0\.01 exceeded/);
	assert.ok(child.killSignals.includes("SIGTERM"));
});
