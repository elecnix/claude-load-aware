/**
 * The hook handler, driven with injected samplers.
 *
 * The load, memory, swap and I/O values come from an object this file owns, so
 * nothing here depends on what the host is doing while the suite runs. The
 * handler is called the way `hook.ts` calls it after parsing a hook's stdin:
 * once per event, with a fresh in-memory state each time and the band state
 * carried only by the cache directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleHook, SAMPLING_EVENTS, type HookDeps, type HookOutput } from "../src/hook.ts";
import type { LoadSample } from "../src/load.ts";
import type { MemorySample } from "../src/memory.ts";
import type { SwapSample } from "../src/swap.ts";
import type { IoPressureSample } from "../src/io.ts";
import type { LoadAwareConfig } from "../src/config.ts";

const GIB = 1024 ** 3;

const DIRECTIVE_PATTERN =
	/\b(stop|halt|avoid|prefer|should|shouldn't|must|wait|pause|defer|delay|reduce|limit|consider|please|try|instead|recommend|suggest|ensure|make sure|continue|retry|run|kill|abort)\b/i;

function loadSample(load1: number): LoadSample {
	return { available: true, load1, load5: load1 * 0.8, load15: load1 * 0.6, source: "os.loadavg" };
}
function memorySample(fraction: number): MemorySample {
	const totalBytes = 32 * GIB;
	return { available: true, totalBytes, usedBytes: Math.round(totalBytes * fraction), usedFraction: fraction, source: "node:os" };
}
function swapSample(fraction: number, totalBytes: number): SwapSample {
	if (totalBytes === 0) return { available: true, totalBytes: 0, usedBytes: 0, usedFraction: 0, source: "/proc/meminfo" };
	return { available: true, totalBytes, usedBytes: Math.round(totalBytes * fraction), usedFraction: fraction, source: "/proc/meminfo" };
}
function ioSample(some10: number): IoPressureSample {
	return { available: true, some10, full10: some10 / 4, source: "/proc/pressure/io" };
}
const deadLoad = (): LoadSample => ({ available: false, load1: 0, load5: 0, load15: 0, source: "unavailable", detail: "test: no sensor" });
const deadIo = (): IoPressureSample => ({ available: false, some10: 0, full10: null, source: "unavailable", detail: "test: no sensor" });

function testConfig(cacheDir: string, overrides: Partial<LoadAwareConfig> = {}): LoadAwareConfig {
	return {
		loadThreshold: 4,
		memoryThreshold: 0.8,
		swapThreshold: 0.5,
		ioThreshold: 0.2,
		enabled: true,
		cacheDir,
		loadThresholdSource: "default",
		memoryThresholdSource: "default",
		swapThresholdSource: "default",
		ioThresholdSource: "default",
		warnings: [],
		elevatedMultiplier: 1,
		highMultiplier: 1.5,
		hysteresis: 0.1,
		...overrides,
	};
}

async function makeHarness(overrides: Partial<LoadAwareConfig> = {}) {
	const cacheDir = await mkdtemp(join(tmpdir(), "claude-load-aware-hook-"));
	const box = { load1: 0.5, loadAvailable: true, memory: 0.3, swap: 0.1, swapTotal: 8 * GIB, io: 0.05, ioAvailable: true };
	const calls = { load: 0, memory: 0, swap: 0, io: 0 };
	const deps: HookDeps = {
		readLoadImpl: async () => {
			calls.load++;
			return box.loadAvailable ? loadSample(box.load1) : deadLoad();
		},
		readMemoryImpl: async () => {
			calls.memory++;
			return memorySample(box.memory);
		},
		readSwapImpl: async () => {
			calls.swap++;
			return swapSample(box.swap, box.swapTotal);
		},
		readIoPressureImpl: async () => {
			calls.io++;
			return box.ioAvailable ? ioSample(box.io) : deadIo();
		},
		loadConfigImpl: async () => testConfig(cacheDir, overrides),
		cpuCountImpl: () => 8,
		now: () => 1_700_000_000_000,
	};
	const input = (event: string, sessionId = "session-a") => ({
		session_id: sessionId,
		transcript_path: "/tmp/example/transcript.jsonl",
		cwd: "/tmp/example",
		hook_event_name: event,
		...(event === "UserPromptSubmit" ? { prompt: "hello" } : {}),
		...(event === "PostToolUse" ? { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {}, tool_use_id: "toolu_example" } : {}),
	});
	return {
		box,
		calls,
		cacheDir,
		deps,
		prompt: (sessionId?: string) => handleHook(input("UserPromptSubmit", sessionId), deps),
		afterTool: (sessionId?: string) => handleHook(input("PostToolUse", sessionId), deps),
		send: (event: string, sessionId?: string) => handleHook(input(event, sessionId), deps),
	};
}

function text(output: HookOutput | undefined): string | undefined {
	return output?.hookSpecificOutput.additionalContext;
}

test("only UserPromptSubmit and PostToolUse sample", () => {
	assert.deepEqual([...SAMPLING_EVENTS].sort(), ["PostToolUse", "UserPromptSubmit"]);
});

test("a quiet machine adds nothing", async () => {
	const h = await makeHarness();
	assert.equal(await h.prompt(), undefined);
	assert.equal(await h.afterTool(), undefined);
});

test("a crossing at a prompt answers UserPromptSubmit with additionalContext", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	const output = await h.prompt();
	assert.deepEqual(Object.keys(output ?? {}), ["hookSpecificOutput"]);
	assert.deepEqual(Object.keys(output!.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
	assert.equal(output!.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.match(text(output)!, /^System resource update\. Measurements only\./);
	assert.match(text(output)!, /Band normal -> elevated/);
});

test("a crossing after a tool answers PostToolUse with additionalContext", async () => {
	const h = await makeHarness();
	await h.prompt();
	h.box.memory = 0.9;
	const output = await h.afterTool();
	assert.equal(output?.hookSpecificOutput.hookEventName, "PostToolUse");
	assert.match(text(output)!, /Memory: .*Band normal -> elevated/);
});

test("band state persists across separate invocations", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	assert.ok(await h.prompt(), "the first invocation reports the crossing");
	assert.equal(await h.afterTool(), undefined, "the second invocation remembers the band, so nothing is repeated");
	h.box.load1 = 9;
	assert.match(text(await h.afterTool())!, /Band elevated -> high/, "the next crossing starts from the stored band");
});

test("a corrupt state file starts from normal and reports the crossing", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	await h.prompt();
	const { writeFile } = await import("node:fs/promises");
	const { statePath } = await import("../src/state.ts");
	await writeFile(statePath(h.cacheDir, "session-a"), "garbage");
	assert.match(text(await h.afterTool())!, /Band normal -> elevated/);
});

test("sessions are isolated from each other", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	assert.ok(await h.prompt("session-a"));
	assert.ok(await h.prompt("session-b"), "a second session reports its own first crossing");
	assert.equal(await h.prompt("session-a"), undefined);
	assert.equal(await h.prompt("session-b"), undefined);
});

test("two concurrent invocations for one session report the crossing once", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	const [one, two] = await Promise.all([h.afterTool(), h.afterTool()]);
	assert.equal([one, two].filter(Boolean).length, 1);
});

test("load and memory crossing in one sample produce one message", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	h.box.memory = 0.9;
	const body = text(await h.prompt())!;
	assert.equal(body.match(/System resource update/g)?.length, 1);
	assert.match(body, /Load average:.*Band normal -> elevated/);
	assert.match(body, /Memory:.*Band normal -> elevated/);
});

test("a message reports every figure with its CPU count", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	const body = text(await h.prompt())!;
	assert.match(body, /Load average: 5\.00 \(1 min\), 4\.00 \(5 min\), 3\.00 \(15 min\) on 8 logical CPUs/);
	assert.match(body, /Memory: 9\.6 GiB of 32\.0 GiB in use \(30%\), band normal\./);
	assert.match(body, /Swap: 819 MiB of 8.0 GiB in use \(10%\), band normal\./);
	assert.match(body, /I\/O pressure: 5\.0% of wall time with at least one task stalled on I\/O, 1\.3% of wall time with every task stalled on I\/O, band normal\./);
});

test("escalation jumps to the justified band and recovery steps down one band per sample", async () => {
	const h = await makeHarness();
	h.box.load1 = 9;
	assert.match(text(await h.prompt())!, /Band normal -> high/);
	h.box.load1 = 0.5;
	assert.match(text(await h.afterTool())!, /Band high -> elevated/);
	assert.match(text(await h.afterTool())!, /Band elevated -> normal/);
	assert.equal(await h.afterTool(), undefined);
});

test("a value inside the hysteresis margin adds nothing", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	await h.prompt();
	h.box.load1 = 3.8; // below the threshold of 4, above the exit point of 3.6
	assert.equal(await h.afterTool(), undefined);
});

test("a dead sensor holds its band and is left out of the message", async () => {
	const h = await makeHarness();
	h.box.load1 = 5;
	await h.prompt();
	h.box.loadAvailable = false;
	h.box.load1 = 0.1;
	assert.equal(await h.afterTool(), undefined, "a dead reader is not a recovery");
	h.box.memory = 0.9;
	const body = text(await h.afterTool())!;
	assert.doesNotMatch(body, /Load average/);
	h.box.loadAvailable = true;
	assert.match(text(await h.afterTool())!, /Load average:.*Band elevated -> normal/);
});

test("a machine with no swap reports none configured", async () => {
	const h = await makeHarness();
	h.box.swapTotal = 0;
	h.box.load1 = 5;
	assert.match(text(await h.prompt())!, /Swap: none configured, band normal\./);
});

test("swap and I/O crossing in one sample produce one message", async () => {
	const h = await makeHarness();
	h.box.swap = 0.9;
	h.box.io = 0.35;
	const body = text(await h.prompt())!;
	assert.match(body, /Swap:.*Band normal -> high/);
	assert.match(body, /I\/O pressure:.*Band normal -> high/);
});

test("a dead I/O sensor is reported on stderr once per session, not to the model", async () => {
	const h = await makeHarness();
	h.box.ioAvailable = false;
	h.box.load1 = 5;
	const written: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void written.push(args.join(" "));
	try {
		const first = await h.prompt();
		await h.afterTool();
		await h.afterTool();
		assert.doesNotMatch(text(first)!, /I\/O/);
	} finally {
		console.error = original;
	}
	assert.equal(written.filter((line) => line.includes("I/O pressure unavailable")).length, 1);
});

test("every event except the two sampling ones is ignored without sampling", async () => {
	const h = await makeHarness();
	h.box.load1 = 50;
	for (const event of ["Stop", "SubagentStop", "PreToolUse", "PostToolUseFailure", "PostToolBatch", "SessionStart", "Notification", "PreCompact", "SessionEnd"]) {
		assert.equal(await h.send(event), undefined, event);
	}
	assert.deepEqual(h.calls, { load: 0, memory: 0, swap: 0, io: 0 });
});

test("a malformed or session-less input is ignored without sampling", async () => {
	const h = await makeHarness();
	for (const bad of [null, "x", 42, {}, { hook_event_name: "PostToolUse" }, { hook_event_name: "PostToolUse", session_id: "" }, { session_id: "s" }]) {
		assert.equal(await handleHook(bad, h.deps), undefined);
	}
	assert.deepEqual(h.calls, { load: 0, memory: 0, swap: 0, io: 0 });
});

test("a disabled hook samples nothing and adds nothing", async () => {
	const h = await makeHarness({ enabled: false });
	h.box.load1 = 50;
	assert.equal(await h.prompt(), undefined);
	assert.equal(await h.afterTool(), undefined);
	assert.deepEqual(h.calls, { load: 0, memory: 0, swap: 0, io: 0 });
});

test("an unreachable threshold keeps the hook quiet", async () => {
	const h = await makeHarness({ loadThreshold: 1e9, memoryThreshold: 1, swapThreshold: 1, ioThreshold: 1 });
	h.box.load1 = 100;
	h.box.memory = 0.99;
	assert.equal(await h.prompt(), undefined);
});

test("each sampling event takes exactly one sample of each sensor", async () => {
	const h = await makeHarness();
	await h.prompt();
	await h.afterTool();
	assert.deepEqual(h.calls, { load: 2, memory: 2, swap: 2, io: 2 });
});

test("a message never tells the model what to do", async () => {
	const h = await makeHarness();
	const texts: string[] = [];
	for (const [load, memory, swap, io] of [
		[5, 0.9, 0.9, 0.3],
		[9, 0.95, 0.95, 0.4],
		[0.5, 0.9, 0.5, 0.1],
		[0.5, 0.3, 0.1, 0.05],
		[0.5, 0.3, 0.1, 0.05],
		[0.5, 0.3, 0.1, 0.05],
	]) {
		Object.assign(h.box, { load1: load, memory, swap, io });
		for (const output of [await h.prompt(), await h.afterTool()]) if (output) texts.push(text(output)!);
	}
	assert.ok(texts.length >= 5, `expected several messages, got ${texts.length}`);
	for (const body of texts) {
		const offending = body.match(DIRECTIVE_PATTERN);
		assert.equal(offending, null, `message addresses the model with "${offending?.[0]}":\n${body}`);
	}
});

test("a handler failure adds nothing and never throws", async () => {
	const h = await makeHarness();
	const broken: HookDeps = { ...h.deps, readLoadImpl: async () => { throw new Error("test: sensor exploded"); } };
	const original = console.error;
	console.error = () => {};
	try {
		const output = await handleHook({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "x" }, broken);
		assert.equal(output, undefined);
	} finally {
		console.error = original;
	}
});
