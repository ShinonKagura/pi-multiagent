import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { RpcCommandQueue } from "../extensions/multiagent/src/rpc-command-queue.ts";

test("RpcCommandQueue starts ack timeout after stdin backpressure drains", async () => {
	const queue = new RpcCommandQueue(100);
	const stdin = new PassThrough({ highWaterMark: 1 });
	stdin.pause();
	let raw = "";
	stdin.on("data", (chunk: Buffer) => {
		raw += chunk.toString("utf8");
	});
	let settled = false;
	const ack = queue.send(stdin, { type: "prompt", message: "x" }).then((result) => {
		settled = true;
		return result;
	});
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(settled, false);
	stdin.resume();
	for (let attempt = 0; raw.length === 0 && attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	const line = raw.trim();
	assert.notEqual(line, "");
	const parsed: unknown = JSON.parse(line);
	if (!isCommandRecord(parsed)) throw new Error("command record must include string id and type");
	queue.handleResponse({ type: "response", id: parsed.id, command: parsed.type, success: true }, () => undefined);
	assert.deepEqual(await ack, { success: true, error: undefined });
});

test("RpcCommandQueue fails promptly when stdin backpressure never drains", async () => {
	const queue = new RpcCommandQueue(10);
	const stdin = new PassThrough({ highWaterMark: 1 });
	stdin.pause();
	const ack = await queue.send(stdin, { type: "prompt", message: "x" });
	assert.equal(ack.success, false);
	assert.match(ack.error ?? "", /RPC stdin write did not drain before timeout for command prompt/);
	assert.equal(stdin.listenerCount("drain"), 0);
	assert.equal(stdin.listenerCount("error"), 0);
});

test("RpcCommandQueue resolves write errors before drain and removes listeners", async () => {
	const queue = new RpcCommandQueue(100);
	const stdin = new PassThrough({ highWaterMark: 1 });
	stdin.pause();
	const ack = queue.send(stdin, { type: "follow_up", message: "x" });
	stdin.emit("error", new Error("EPIPE"));
	assert.deepEqual(await ack, { success: false, error: "RPC stdin write failed before drain: EPIPE" });
	assert.equal(stdin.listenerCount("drain"), 0);
	assert.equal(stdin.listenerCount("error"), 0);
});

test("RpcCommandQueue closeWith resolves commands waiting for drain", async () => {
	const queue = new RpcCommandQueue(100);
	const stdin = new PassThrough({ highWaterMark: 1 });
	stdin.pause();
	const ack = queue.send(stdin, { type: "steer", message: "x" });
	queue.closeWith((command) => `closed ${command}`);
	assert.deepEqual(await ack, { success: false, error: "closed steer" });
	assert.equal(stdin.listenerCount("drain"), 0);
	assert.equal(stdin.listenerCount("error"), 0);
});

test("RpcCommandQueue accepts responses before a backpressured write drains", async () => {
	const queue = new RpcCommandQueue(100);
	const stdin = new ControlledCommandWriter(false);
	const ack = queue.send(stdin, { type: "follow_up", message: "x" });
	const parsed: unknown = JSON.parse(stdin.line);
	if (!isCommandRecord(parsed)) throw new Error("command record must include string id and type");
	queue.handleResponse({ type: "response", id: parsed.id, command: parsed.type, success: true }, () => undefined);
	assert.deepEqual(await ack, { success: true, error: undefined });
	assert.equal(stdin.listenerCount("drain"), 0);
	assert.equal(stdin.listenerCount("error"), 0);
	stdin.emit("drain");
	assert.equal(queue.pendingCount, 0);
});

test("RpcCommandQueue honors a per-command timeout override (short override fires before long default)", async () => {
	const queue = new RpcCommandQueue(5_000); // long default; the live-command override must win
	const stdin = new PassThrough();
	stdin.resume();
	const started = Date.now();
	const ack = await queue.send(stdin, { type: "steer", message: "x" }, 30);
	const elapsed = Date.now() - started;
	assert.equal(ack.success, false);
	assert.match(ack.error ?? "", /RPC command steer timed out waiting for response/);
	assert.ok(elapsed < 1_000, `per-command override (30ms) must fire well before the 5s default; elapsed=${elapsed}ms`);
});

class ControlledCommandWriter extends PassThrough {
	line = "";
	private readonly flushed: boolean;

	constructor(flushed: boolean) {
		super();
		this.flushed = flushed;
	}

	override write(chunk: string | Uint8Array, encoding?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void): boolean {
		this.line += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (typeof encoding === "function") encoding(undefined);
		callback?.(undefined);
		return this.flushed;
	}
}

function isCommandRecord(value: unknown): value is { id: string; type: string } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "id" in value && typeof value.id === "string" && "type" in value && typeof value.type === "string";
}
