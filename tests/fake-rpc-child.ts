/** Shared in-memory fake pi child for tests that must not spawn a real pi launcher.
 *
 * Speaks just enough of the JSONL RPC protocol to ack commands and, in "success" mode, complete a
 * single step (assistant final + agent_end). Use `fakeSpawn(...)` as a SpawnProcess so DetachedRun /
 * RpcChildController never launch a real child process — which keeps the suite hermetic on a clean
 * CI runner that has no pi on PATH. Pair with PI_MULTIAGENT_PI_LAUNCHER so getPiInvocation resolves a
 * (never actually executed) launcher path.
 */

import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import type { SpawnOptions, SpawnProcess } from "../extensions/multiagent/src/child-launch.ts";
import type { RpcJsonRecord } from "../extensions/multiagent/src/rpc-jsonl.ts";

export type FakeRpcChildBehavior = "success" | "no-terminal";

export class FakeRpcChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	readonly killSignals: NodeJS.Signals[] = [];
	private readonly behavior: FakeRpcChildBehavior;
	unrefCalls = 0;
	exitCode: number | null = null;
	pid: number | undefined = undefined;

	constructor(behavior: FakeRpcChildBehavior) {
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

/** A SpawnProcess that returns FakeRpcChild instances instead of launching a real pi process. */
export function fakeSpawn(behavior: FakeRpcChildBehavior = "success", onChild?: (child: FakeRpcChild) => void): SpawnProcess {
	return ((_command: string, _args: string[], _options: SpawnOptions) => {
		const child = new FakeRpcChild(behavior);
		onChild?.(child);
		return child as unknown as ChildProcessWithoutNullStreams;
	}) as SpawnProcess;
}
