/** B3 cross-extension RPC bridge tests: drive the handlers via a real EventBus and assert the reply
 * envelopes, including success and error paths for ping/stop/spawn. */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { registerSubagentsRpc, requestId, requestParams, SUBAGENTS_RPC, type SubagentsRpcDeps, type SubagentsRpcReply } from "../extensions/multiagent/src/rpc-bridge.ts";

function harness(overrides: Partial<SubagentsRpcDeps> = {}) {
	const bus = createEventBus();
	const replies: SubagentsRpcReply[] = [];
	bus.on(SUBAGENTS_RPC.reply, (data) => replies.push(data as SubagentsRpcReply));
	const deps: SubagentsRpcDeps = {
		version: "0.5.0-test",
		spawn: async (params) => ({ runId: String(params.runId ?? "r1") }),
		stop: (params) => ({ runId: String(params.runId), stopped: true }),
		...overrides,
	};
	const off = registerSubagentsRpc(bus, deps);
	return { bus, replies, off };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("ping replies synchronously with liveness + version", () => {
	const { bus, replies } = harness();
	bus.emit(SUBAGENTS_RPC.ping, { id: "1" });
	assert.equal(replies.length, 1);
	assert.deepEqual(replies[0], { id: "1", method: "ping", ok: true, result: { pong: true, extension: "hb-orchestra", version: "0.5.0-test" } });
});

test("stop replies ok with the dep result and reflects the correlation id", () => {
	const { bus, replies } = harness();
	bus.emit(SUBAGENTS_RPC.stop, { id: 7, params: { runId: "r2" } });
	assert.equal(replies.length, 1);
	assert.equal(replies[0]?.id, "7");
	assert.equal(replies[0]?.ok, true);
	assert.deepEqual(replies[0]?.result, { runId: "r2", stopped: true });
});

test("stop reply carries the error message when the dep throws (unknown runId)", () => {
	const { bus, replies } = harness({
		stop: () => {
			throw new Error("unknown runId r9");
		},
	});
	bus.emit(SUBAGENTS_RPC.stop, { id: "8", params: { runId: "r9" } });
	assert.equal(replies[0]?.ok, false);
	assert.equal(replies[0]?.method, "stop");
	assert.match(replies[0]?.error ?? "", /unknown runId r9/);
});

test("spawn replies asynchronously with the started runId", async () => {
	const { bus, replies } = harness({ spawn: async () => ({ runId: "spawned-1" }) });
	bus.emit(SUBAGENTS_RPC.spawn, { id: "3", params: { graph: { objective: "x", steps: [] } } });
	assert.equal(replies.length, 0, "spawn is async; no synchronous reply");
	await tick();
	assert.equal(replies[0]?.ok, true);
	assert.deepEqual(replies[0]?.result, { runId: "spawned-1" });
});

test("spawn reply carries the error message when starting rejects", async () => {
	const { bus, replies } = harness({
		spawn: async () => {
			throw new Error("spawn requires a graph");
		},
	});
	bus.emit(SUBAGENTS_RPC.spawn, { id: "4", params: {} });
	await tick();
	assert.equal(replies[0]?.ok, false);
	assert.match(replies[0]?.error ?? "", /spawn requires a graph/);
});

test("unsubscribe stops further handling", () => {
	const { bus, replies, off } = harness();
	off();
	bus.emit(SUBAGENTS_RPC.ping, { id: "1" });
	assert.equal(replies.length, 0);
});

test("requestId / requestParams parse id and params (or fall back to the whole payload)", () => {
	assert.equal(requestId({ id: "a" }), "a");
	assert.equal(requestId({ id: 5 }), "5");
	assert.equal(requestId({}), undefined);
	assert.deepEqual(requestParams({ params: { runId: "r1" } }), { runId: "r1" });
	assert.deepEqual(requestParams({ runId: "r1" }), { runId: "r1" });
	assert.deepEqual(requestParams(undefined), {});
});
