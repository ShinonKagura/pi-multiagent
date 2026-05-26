/** NEU-C: in-process schedule registry for detached-graph re-firing. */

/**
 * Scope (deliberate cut, see ADR if extended):
 * - Interval ("5m", "1h", "30s") and one-shot ("+10m" or ISO timestamp) only.
 * - No cron grammar (too much surface for the value; use external cron + `start` instead).
 * - In-memory only \u2014 schedules are forgotten on Pi reload/crash. Documented limit.
 * - Per-session ownership: scheduleId is process-local; fires only while the originating
 *   Pi session is active. After session shutdown, the schedule is canceled.
 * - Fires re-invoke `runAgentTeam` against the original graph + options via an injected
 *   `fire` callback so this module stays decoupled from the dispatcher.
 */

import type { GraphSpec } from "./schemas.ts";
import type { ScheduleSpec, ScheduledRunSummary } from "./types.ts";

const SCHEDULE_ID_PATTERN = /^s[1-9][0-9]{0,6}$/;
const MAX_SCHEDULE_ID_SERIAL = 9_999_999;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RELATIVE_REGEX = /^(\d+)(ms|s|m|h|d)$/;
const RELATIVE_PLUS_REGEX = /^\+(\d+)(ms|s|m|h|d)$/;

export interface ParsedSchedule {
	kind: "interval" | "oneShot";
	milliseconds: number;
	firesAtIso?: string;
}

export type ScheduleParseResult = { ok: true; value: ParsedSchedule } | { ok: false; error: string };

/** Parse the ScheduleSpec into a concrete fire description. */
export function parseScheduleSpec(spec: ScheduleSpec, now: Date = new Date()): ScheduleParseResult {
	const intervalCount = spec.interval ? 1 : 0;
	const oneShotCount = spec.oneShot ? 1 : 0;
	if (intervalCount + oneShotCount !== 1) {
		return { ok: false, error: "Schedule must set exactly one of 'interval' or 'oneShot'." };
	}
	if (spec.interval) {
		const ms = parseRelative(spec.interval);
		if (ms === undefined) return { ok: false, error: `interval must match \\d+(ms|s|m|h|d), got ${JSON.stringify(spec.interval)}.` };
		if (ms < MIN_INTERVAL_MS) return { ok: false, error: `interval must be \u2265 ${MIN_INTERVAL_MS}ms (current: ${ms}ms).` };
		if (ms > MAX_INTERVAL_MS) return { ok: false, error: `interval must be \u2264 ${MAX_INTERVAL_MS}ms / 30 days (current: ${ms}ms).` };
		return { ok: true, value: { kind: "interval", milliseconds: ms } };
	}
	const oneShot = spec.oneShot ?? "";
	let fireAt: number;
	const plus = parseRelativePlus(oneShot);
	if (plus !== undefined) {
		fireAt = now.getTime() + plus;
	} else {
		const parsed = Date.parse(oneShot);
		if (Number.isNaN(parsed)) return { ok: false, error: `oneShot must be ISO timestamp or +\\d+(ms|s|m|h|d), got ${JSON.stringify(oneShot)}.` };
		fireAt = parsed;
	}
	const delta = fireAt - now.getTime();
	if (delta < 0) return { ok: false, error: `oneShot is in the past (${new Date(fireAt).toISOString()}).` };
	if (delta > MAX_INTERVAL_MS) return { ok: false, error: `oneShot is too far in the future (max +30 days).` };
	return { ok: true, value: { kind: "oneShot", milliseconds: delta, firesAtIso: new Date(fireAt).toISOString() } };
}

function parseRelative(input: string): number | undefined {
	const match = input.match(RELATIVE_REGEX);
	if (!match) return undefined;
	return toMilliseconds(Number.parseInt(match[1] ?? "", 10), match[2] ?? "");
}

function parseRelativePlus(input: string): number | undefined {
	const match = input.match(RELATIVE_PLUS_REGEX);
	if (!match) return undefined;
	return toMilliseconds(Number.parseInt(match[1] ?? "", 10), match[2] ?? "");
}

function toMilliseconds(count: number, unit: string): number {
	switch (unit) {
		case "ms": return count;
		case "s": return count * 1000;
		case "m": return count * 60 * 1000;
		case "h": return count * 60 * 60 * 1000;
		case "d": return count * 24 * 60 * 60 * 1000;
		default: return 0;
	}
}

interface ScheduledRunEntry {
	id: string;
	spec: ScheduleSpec;
	parsed: ParsedSchedule;
	graph: GraphSpec;
	ownerSessionId: string | undefined;
	createdAt: string;
	timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
	fireCount: number;
	lastFireAt: string | undefined;
	lastFireError: string | undefined;
	nextFireAtIso: string | undefined;
}

/** Fire callback: invoked when a schedule's timer triggers. Must not throw. */
export type ScheduleFireCallback = (input: { scheduleId: string; graph: GraphSpec; ownerSessionId: string | undefined }) => Promise<void> | void;

export class ScheduledRunRegistry {
	private readonly entries = new Map<string, ScheduledRunEntry>();
	private nextSerial = 1;
	private readonly fire: ScheduleFireCallback;

	constructor(fire: ScheduleFireCallback) {
		this.fire = fire;
	}

	register(input: { spec: ScheduleSpec; graph: GraphSpec; ownerSessionId: string | undefined }): { ok: true; id: string; parsed: ParsedSchedule } | { ok: false; error: string } {
		const parsed = parseScheduleSpec(input.spec);
		if (!parsed.ok) return { ok: false, error: parsed.error };
		const id = this.allocateId();
		if (!id) return { ok: false, error: "Schedule id pool exhausted; reload Pi to reset." };
		const now = new Date();
		const entry: ScheduledRunEntry = {
			id,
			spec: input.spec,
			parsed: parsed.value,
			graph: input.graph,
			ownerSessionId: input.ownerSessionId,
			createdAt: now.toISOString(),
			timer: undefined as never, // assigned below
			fireCount: 0,
			lastFireAt: undefined,
			lastFireError: undefined,
			nextFireAtIso: parsed.value.kind === "oneShot" ? parsed.value.firesAtIso : new Date(now.getTime() + parsed.value.milliseconds).toISOString(),
		};
		entry.timer = this.armTimer(entry);
		this.entries.set(id, entry);
		return { ok: true, id, parsed: parsed.value };
	}

	cancel(id: string, ownerSessionId: string | undefined): { ok: true } | { ok: false; error: string } {
		const entry = this.entries.get(id);
		if (!entry) return { ok: false, error: `Schedule ${id} not found.` };
		if (ownerSessionId !== undefined && entry.ownerSessionId !== undefined && entry.ownerSessionId !== ownerSessionId) return { ok: false, error: `Schedule ${id} is owned by another session.` };
		this.clearTimer(entry);
		this.entries.delete(id);
		return { ok: true };
	}

	cancelAllOwnedBy(sessionId: string): number {
		let canceled = 0;
		for (const [id, entry] of this.entries.entries()) {
			if (entry.ownerSessionId === sessionId) {
				this.clearTimer(entry);
				this.entries.delete(id);
				canceled += 1;
			}
		}
		return canceled;
	}

	list(): ScheduledRunSummary[] {
		return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id)).map((entry) => ({
			scheduleId: entry.id,
			kind: entry.parsed.kind,
			intervalMs: entry.parsed.kind === "interval" ? entry.parsed.milliseconds : undefined,
			nextFireAt: entry.nextFireAtIso,
			createdAt: entry.createdAt,
			fireCount: entry.fireCount,
			lastFireAt: entry.lastFireAt,
			lastFireError: entry.lastFireError,
			ownerSessionId: entry.ownerSessionId,
			objective: entry.graph.objective,
			stepCount: entry.graph.steps.length,
		}));
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	clearAll(): void {
		for (const entry of this.entries.values()) this.clearTimer(entry);
		this.entries.clear();
	}

	private armTimer(entry: ScheduledRunEntry): ReturnType<typeof setTimeout> {
		if (entry.parsed.kind === "interval") {
			const timer = setInterval(() => this.handleFire(entry), entry.parsed.milliseconds);
			(timer as { unref?: () => void }).unref?.();
			return timer;
		}
		const timer = setTimeout(() => {
			void this.handleFire(entry);
			this.entries.delete(entry.id);
		}, entry.parsed.milliseconds);
		(timer as { unref?: () => void }).unref?.();
		return timer;
	}

	private clearTimer(entry: ScheduledRunEntry): void {
		if (entry.parsed.kind === "interval") clearInterval(entry.timer as ReturnType<typeof setInterval>);
		else clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
	}

	private async handleFire(entry: ScheduledRunEntry): Promise<void> {
		try {
			await this.fire({ scheduleId: entry.id, graph: entry.graph, ownerSessionId: entry.ownerSessionId });
			entry.fireCount += 1;
			entry.lastFireAt = new Date().toISOString();
			entry.lastFireError = undefined;
		} catch (error) {
			entry.fireCount += 1;
			entry.lastFireAt = new Date().toISOString();
			entry.lastFireError = error instanceof Error ? error.message : String(error);
		}
		if (entry.parsed.kind === "interval") {
			entry.nextFireAtIso = new Date(Date.now() + entry.parsed.milliseconds).toISOString();
		} else {
			entry.nextFireAtIso = undefined;
		}
	}

	private allocateId(): string | undefined {
		while (this.nextSerial <= MAX_SCHEDULE_ID_SERIAL) {
			const candidate = `s${this.nextSerial}`;
			this.nextSerial += 1;
			if (!this.entries.has(candidate)) return candidate;
		}
		return undefined;
	}
}

export function isScheduleId(value: string): boolean {
	return SCHEDULE_ID_PATTERN.test(value);
}
