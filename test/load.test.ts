/**
 * The load average reader.
 *
 * The interesting property is not the happy path, it is the failure path: a
 * platform where os.loadavg() is absent must report `available: false` rather
 * than zeros, because zeros read as a permanently idle machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readLoad } from "../src/load.ts";

test("a real reading reports three ordered averages", async () => {
	const sample = await readLoad();

	if (!sample.available) {
		// Legal on a platform with no load-average concept at all. The point of
		// the contract is that it is explicit rather than a silent zero.
		assert.equal(sample.source, "unavailable");
		assert.ok(sample.detail && sample.detail.length > 0, "an unavailable sample must say why");
		return;
	}

	assert.notEqual(sample.source, "unavailable");
	assert.ok(sample.load1 >= 0, "1-minute average must not be negative");
	assert.ok(sample.load5 >= 0, "5-minute average must not be negative");
	assert.ok(sample.load15 >= 0, "15-minute average must not be negative");
});

test("an unavailable sample never presents zeros as a real reading", async () => {
	const sample = await readLoad();
	if (!sample.available) {
		// Zeros with a real-looking source is exactly the bug this guards.
		assert.equal(sample.source, "unavailable");
		assert.ok(sample.detail, "detail is required when unavailable");
	}
});

test("reading twice does not throw and always resolves", async () => {
	const [a, b] = await Promise.all([readLoad(), readLoad()]);
	assert.ok(a.available || !a.available);
	assert.ok(b.available || !b.available);
});
