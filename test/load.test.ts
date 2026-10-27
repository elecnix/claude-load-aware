/**
 * The load average reader.
 *
 * The interesting property is the failure path: a platform where
 * os.loadavg() is absent must report `available: false` rather than zeros,
 * because zeros read as a permanently idle machine. Every source is injected,
 * so each path runs on any host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readLoad, type LoadReaderOptions } from "../src/load.ts";

const fail = async (): Promise<never> => {
	throw new Error("test: source failed");
};

test("os.loadavg answers first and reports three averages", async () => {
	const sample = await readLoad({ platform: "linux", loadavgImpl: () => [1.5, 1, 0.5] });
	assert.deepEqual(sample, { available: true, load1: 1.5, load5: 1, load15: 0.5, source: "os.loadavg" });
});

test("a genuinely idle machine reads as zeros with a real source", async () => {
	const sample = await readLoad({ platform: "linux", loadavgImpl: () => [0, 0, 0] });
	assert.equal(sample.available, true);
	assert.equal(sample.source, "os.loadavg");
});

test("/proc/loadavg answers when os.loadavg yields nothing usable", async () => {
	const sample = await readLoad({
		platform: "linux",
		loadavgImpl: () => [],
		readFileImpl: async () => "2.00 1.50 1.00 3/456 7890\n",
	});
	assert.deepEqual(sample, { available: true, load1: 2, load5: 1.5, load15: 1, source: "/proc/loadavg" });
});

test("sysctl answers when the first two sources fail", async () => {
	const sample = await readLoad({
		platform: "darwin",
		loadavgImpl: () => [Number.NaN, 0, 0],
		readFileImpl: fail,
		execFileImpl: async () => "{ 1.82 2.01 2.10 }\n",
	});
	assert.deepEqual(sample, { available: true, load1: 1.82, load5: 2.01, load15: 2.1, source: "sysctl" });
});

test("Windows reports unavailable instead of the zeros os.loadavg returns there", async () => {
	const sample = await readLoad({
		platform: "win32",
		loadavgImpl: () => [0, 0, 0],
		readFileImpl: fail,
		execFileImpl: fail,
	});
	assert.equal(sample.available, false);
	assert.equal(sample.source, "unavailable");
	assert.match(sample.detail ?? "", /win32/);
	assert.deepEqual([sample.load1, sample.load5, sample.load15], [0, 0, 0]);
});

test("every source failing yields an unavailable sample that says why", async () => {
	const options: LoadReaderOptions = { platform: "linux", loadavgImpl: () => {
			throw new Error("test: source failed");
		}, readFileImpl: fail, execFileImpl: fail };
	const sample = await readLoad(options);
	assert.equal(sample.available, false);
	assert.equal(sample.source, "unavailable");
	assert.ok(sample.detail && sample.detail.length > 0);
});

test("a negative or non-numeric figure is rejected, not reported", async () => {
	for (const values of [[-1, 0, 0], [Number.NaN, 0, 0], [1, 2]]) {
		const sample = await readLoad({ platform: "linux", loadavgImpl: () => values, readFileImpl: fail, execFileImpl: fail });
		assert.equal(sample.available, false, JSON.stringify(values));
	}
});

test("the real reader returns a well-formed sample on this host", async () => {
	const [a, b] = await Promise.all([readLoad(), readLoad()]);
	for (const sample of [a, b]) {
		assert.equal(typeof sample.available, "boolean");
		if (sample.available) {
			assert.notEqual(sample.source, "unavailable");
			for (const value of [sample.load1, sample.load5, sample.load15]) assert.ok(Number.isFinite(value) && value >= 0);
		} else {
			assert.equal(sample.source, "unavailable");
			assert.ok(sample.detail);
		}
	}
});
