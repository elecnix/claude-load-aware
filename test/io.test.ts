/**
 * The disk I/O contention reader.
 *
 * The measure is PSI stall share, and the tests pin the two things that make
 * it trustworthy: a missing `some` line is unavailable rather than zero, and
 * the percentages become fractions in [0, 1] without arithmetic surprises.
 *
 * PSI is Linux-only, so the unsupported-platform case is a first-class path
 * here rather than an afterthought: a reader that invented a number from
 * `%util` or `iowait` would be answering a different question.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readIoPressure, parsePressure } from "../src/io.ts";

const PSI = `some avg10=10.61 avg60=11.47 avg300=11.59 total=176015945404
full avg10=2.77 avg60=3.18 avg300=3.02 total=134160934492
`;

/** Some kernels report only `some`, and the reader tolerates that. */
const PSI_SOME_ONLY = "some avg10=0.00 avg60=0.01 avg300=0.03 total=859923879\n";

test("parsePressure reads the some and full lines", () => {
	const parsed = parsePressure(PSI);
	assert.ok(parsed, "a valid PSI file must parse");
	assert.deepEqual(parsed.some, { avg10: 10.61, avg60: 11.47, avg300: 11.59, totalMicros: 176015945404 });
	assert.ok(parsed.full);
	assert.equal(parsed.full.avg10, 2.77);
});

test("parsePressure tolerates a missing full line", () => {
	const parsed = parsePressure(PSI_SOME_ONLY);
	assert.ok(parsed);
	assert.equal(parsed.some.avg10, 0);
	assert.equal(parsed.full, null, "a line the kernel did not write is not invented");
});

test("parsePressure rejects output without a usable some line", () => {
	assert.equal(parsePressure(""), null);
	assert.equal(parsePressure("full avg10=2.77 avg60=3.18 avg300=3.02 total=1\n"), null);
	assert.equal(parsePressure("some avg10=oops avg60=3.18 avg300=3.02 total=1\n"), null);
	assert.equal(parsePressure("some avg10=-1 avg60=-1 avg300=-1 total=1\n"), null);
});

test("Linux reports the stall share as a fraction", async () => {
	const sample = await readIoPressure({
		platform: "linux",
		readFileImpl: async () => PSI,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "/proc/pressure/io");
	assert.ok(Math.abs(sample.some10 - 0.1061) < 1e-12);
	assert.ok(sample.full10 !== null && Math.abs(sample.full10 - 0.0277) < 1e-12);
});

test("a full line the kernel omits becomes null, not zero", async () => {
	const sample = await readIoPressure({
		platform: "linux",
		readFileImpl: async () => PSI_SOME_ONLY,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.full10, null);
});

test("Linux reports unavailable when /proc/pressure/io is missing", async () => {
	const sample = await readIoPressure({
		platform: "linux",
		readFileImpl: async () => {
			throw new Error("ENOENT");
		},
	});
	assert.equal(sample.available, false);
	assert.equal(sample.source, "unavailable");
	assert.match(String(sample.detail), /unavailable/);
});

test("Linux reports unavailable when the file has no some line", async () => {
	const sample = await readIoPressure({ platform: "linux", readFileImpl: async () => "garbage\n" });
	assert.equal(sample.available, false);
	assert.equal(sample.some10, 0, "unavailable is not a stall reading");
});

test("a platform without pressure stall accounting reports unavailable", async () => {
	for (const platform of ["darwin", "win32"] as const) {
		const sample = await readIoPressure({ platform });
		assert.equal(sample.available, false, `${platform} has no PSI`);
		assert.equal(sample.source, "unavailable");
		assert.match(String(sample.detail), new RegExp(platform));
	}
});

test("a real reading on Linux is available and bounded", async () => {
	const sample = await readIoPressure();
	if (!sample.available) {
		assert.equal(sample.source, "unavailable");
		assert.ok(sample.detail);
		return;
	}
	assert.ok(sample.some10 >= 0);
	if (sample.full10 !== null) {
		assert.ok(sample.full10 >= 0);
		assert.ok(sample.full10 <= sample.some10, "full stall time cannot exceed some stall time");
	}
});
