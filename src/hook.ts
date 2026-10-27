/**
 * The hook handler: one hook event in, at most one hook answer out.
 *
 * Claude Code runs a hook command once per event and passes the event as JSON
 * on stdin. This module samples at exactly two events and nowhere else:
 *
 *   - `UserPromptSubmit`, when a user prompt is about to start a turn;
 *   - `PostToolUse`, after a tool call finished while the turn is running.
 *
 * Both accept `hookSpecificOutput.additionalContext`, which Claude Code adds
 * to the model's context for the turn in progress. The answer never carries
 * `decision`, `continue`, `stopReason` or any other field that changes what
 * the harness does next. `Stop` and `SubagentStop` are deliberately not
 * handled: their `additionalContext` makes the model take another step, which
 * would start a new turn. The README lists what each event does.
 *
 * The handler never throws. A failure adds nothing to the turn and is written
 * to stderr, because a hook that fails loudly interrupts the session it is
 * meant to describe.
 */

import { readLoad, type LoadSample } from "./load.ts";
import { readMemory, type MemorySample } from "./memory.ts";
import { readSwap, type SwapSample } from "./swap.ts";
import { readIoPressure, type IoPressureSample } from "./io.ts";
import { formatCombinedReport, type Change } from "./report.ts";
import { nextBand, isCrossing, SIGNALS, type Signal } from "./signals.ts";
import { loadConfig, cpuCount, type LoadAwareConfig } from "./config.ts";
import { readState, writeState, pruneState, statePath, withSessionLock } from "./state.ts";
import { access } from "node:fs/promises";

/** The only events that sample. Anything else is ignored without a read. */
export const SAMPLING_EVENTS = ["UserPromptSubmit", "PostToolUse"] as const;
export type SamplingEvent = (typeof SAMPLING_EVENTS)[number];

export type HookOutput = {
	hookSpecificOutput: {
		hookEventName: SamplingEvent;
		additionalContext: string;
	};
};

export type HookDeps = {
	/** Injected for tests. Defaults to the real sampler. */
	readLoadImpl?: () => Promise<LoadSample>;
	readMemoryImpl?: () => Promise<MemorySample>;
	readSwapImpl?: () => Promise<SwapSample>;
	readIoPressureImpl?: () => Promise<IoPressureSample>;
	loadConfigImpl?: typeof loadConfig;
	cpuCountImpl?: () => number;
	now?: () => number;
};

function debugEnabled(): boolean {
	return process.env.CLAUDE_LOAD_AWARE_DEBUG === "1";
}

function isSamplingEvent(value: unknown): value is SamplingEvent {
	return typeof value === "string" && (SAMPLING_EVENTS as readonly string[]).includes(value);
}

const UNAVAILABLE_LABEL: Record<Signal, string> = {
	load: "load average",
	memory: "memory",
	swap: "swap",
	io: "I/O pressure",
};

async function sampleAndReport(
	sessionId: string,
	config: LoadAwareConfig,
	deps: Required<HookDeps>,
): Promise<string | null> {
	const now = deps.now();
	const existed = await access(statePath(config.cacheDir, sessionId)).then(() => true, () => false);
	const state = await readState(config.cacheDir, sessionId, now);

	const [load, memory, swap, io] = await Promise.all([
		deps.readLoadImpl(),
		deps.readMemoryImpl(),
		deps.readSwapImpl(),
		deps.readIoPressureImpl(),
	]);
	const samples = { load, memory, swap, io };

	// A broken sensor is reported on stderr once per session, and its band
	// holds until the sensor returns. A machine with no swap is not broken:
	// the reader reports the absence as a reading.
	for (const signal of SIGNALS) {
		const sample = samples[signal];
		if (!sample.available && !state.unavailableNotified[signal]) {
			state.unavailableNotified[signal] = true;
			console.error(`[claude-load-aware] ${UNAVAILABLE_LABEL[signal]} unavailable: ${sample.detail}`);
		}
	}

	const values: Array<[Signal, number | null, number]> = [
		["load", load.available ? load.load1 : null, config.loadThreshold],
		["memory", memory.available ? memory.usedFraction : null, config.memoryThreshold],
		["swap", swap.available ? swap.usedFraction : null, config.swapThreshold],
		["io", io.available ? io.some10 : null, config.ioThreshold],
	];

	const changes: Change[] = [];
	for (const [signal, value, threshold] of values) {
		if (value === null) continue;
		const previous = state.bands[signal];
		const next = nextBand(previous, value, threshold, config);
		if (isCrossing(previous, next)) {
			changes.push({ signal, previous, next });
			state.bands[signal] = next;
		}
	}

	state.updatedAt = now;
	await writeState(config.cacheDir, sessionId, state);
	// A session's first write is the moment a new file appears, so pruning
	// here keeps the directory bounded without a pass on every event.
	if (!existed) await pruneState(config.cacheDir, now);

	if (changes.length === 0) return null;
	if (debugEnabled()) {
		for (const change of changes) console.error(`[claude-load-aware] ${change.signal} ${change.previous} -> ${change.next}`);
	}
	return formatCombinedReport(changes, { load, memory, swap, io, bands: state.bands, cpus: deps.cpuCountImpl() });
}

/**
 * Handle one hook input. Returns the hook's answer, or undefined when there is
 * nothing to add: an unwired event, a malformed input, a disabled tool, a
 * quiet machine, or a failure.
 */
export async function handleHook(input: unknown, deps: HookDeps = {}): Promise<HookOutput | undefined> {
	if (!input || typeof input !== "object") return undefined;
	const { hook_event_name: event, session_id: sessionId } = input as Record<string, unknown>;
	if (!isSamplingEvent(event)) return undefined;
	if (typeof sessionId !== "string" || sessionId === "") return undefined;

	const resolved: Required<HookDeps> = {
		readLoadImpl: deps.readLoadImpl ?? readLoad,
		readMemoryImpl: deps.readMemoryImpl ?? readMemory,
		readSwapImpl: deps.readSwapImpl ?? readSwap,
		readIoPressureImpl: deps.readIoPressureImpl ?? readIoPressure,
		loadConfigImpl: deps.loadConfigImpl ?? loadConfig,
		cpuCountImpl: deps.cpuCountImpl ?? cpuCount,
		now: deps.now ?? Date.now,
	};

	try {
		const config = await resolved.loadConfigImpl();
		for (const warning of config.warnings) console.error(`[claude-load-aware] ${warning}`);
		if (!config.enabled) return undefined;

		const report = await withSessionLock(config.cacheDir, sessionId, () => sampleAndReport(sessionId, config, resolved));
		if (!report) return undefined;
		return { hookSpecificOutput: { hookEventName: event, additionalContext: report } };
	} catch (error) {
		console.error(`[claude-load-aware] ${event} failed: ${(error as Error).message}`);
		return undefined;
	}
}

