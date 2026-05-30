/** B3: cross-extension RPC surface over the shared Pi EventBus.
 *
 * Other extensions can drive hb-orchestra programmatically by emitting on these channels; hb-orchestra
 * answers each request with a reply envelope on `subagents:rpc:reply`. This DEFINES hb-orchestra's
 * cross-extension contract (there is no legacy pi-subagents protocol spec to mirror byte-for-byte):
 *
 *   request  -> emit("subagents:rpc:<method>", { id?, params? })
 *   response <- emit("subagents:rpc:reply",    { id?, method, ok, result?|error? })
 *
 * Methods: ping (liveness), spawn (start a detached run, result { runId }), stop (cancel a run).
 * The dispatch is pure wiring over injected deps so it can be exercised with a test EventBus.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

export const SUBAGENTS_RPC = {
	ping: "subagents:rpc:ping",
	spawn: "subagents:rpc:spawn",
	stop: "subagents:rpc:stop",
	reply: "subagents:rpc:reply",
} as const;

export type SubagentsRpcMethod = "ping" | "spawn" | "stop";

export interface SubagentsRpcDeps {
	/** hb-orchestra version surfaced in ping replies. */
	version: string;
	/** Start a detached run from request params; resolves with the new runId or rejects with an error. */
	spawn(params: Record<string, unknown>): Promise<{ runId: string }>;
	/** Cancel a running run from request params; throws on an unknown/invalid runId. */
	stop(params: Record<string, unknown>): { runId: string; stopped: boolean };
}

export interface SubagentsRpcReply {
	id: string | undefined;
	method: SubagentsRpcMethod;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export function requestId(data: unknown): string | undefined {
	if (data && typeof data === "object" && "id" in data) {
		const id = (data as { id?: unknown }).id;
		if (typeof id === "string") return id;
		if (typeof id === "number" && Number.isFinite(id)) return String(id);
	}
	return undefined;
}

export function requestParams(data: unknown): Record<string, unknown> {
	if (data && typeof data === "object") {
		const params = (data as { params?: unknown }).params;
		if (params && typeof params === "object") return params as Record<string, unknown>;
		return data as Record<string, unknown>;
	}
	return {};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Register hb-orchestra's cross-extension RPC handlers on the shared EventBus. Returns an unsubscribe. */
export function registerSubagentsRpc(events: EventBus, deps: SubagentsRpcDeps): () => void {
	const reply = (envelope: SubagentsRpcReply): void => events.emit(SUBAGENTS_RPC.reply, envelope);
	const unsubscribes: Array<() => void> = [];

	unsubscribes.push(
		events.on(SUBAGENTS_RPC.ping, (data) => {
			reply({ id: requestId(data), method: "ping", ok: true, result: { pong: true, extension: "hb-orchestra", version: deps.version } });
		}),
	);

	unsubscribes.push(
		events.on(SUBAGENTS_RPC.stop, (data) => {
			const id = requestId(data);
			try {
				reply({ id, method: "stop", ok: true, result: deps.stop(requestParams(data)) });
			} catch (error) {
				reply({ id, method: "stop", ok: false, error: errorMessage(error) });
			}
		}),
	);

	unsubscribes.push(
		events.on(SUBAGENTS_RPC.spawn, (data) => {
			const id = requestId(data);
			void deps
				.spawn(requestParams(data))
				.then((result) => reply({ id, method: "spawn", ok: true, result }))
				.catch((error) => reply({ id, method: "spawn", ok: false, error: errorMessage(error) }));
		}),
	);

	return () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
	};
}
