/**
 * The swap usage reader.
 *
 * Two failure modes matter here. A machine with no swap configured must read
 * as "none configured" rather than as a fraction of nothing, and a source
 * that cannot be read must report `available: false` rather than zero — a
 * zero swap figure reads as idle and would hide a machine that is out of
 * backing store.
 *
 * Both platform parsers are exercised with captured output so the Linux and
 * macOS paths stay covered on any host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { readSwap, parseMeminfoSwap, parseSwapusage } from "../src/swap.ts";

const MIB = 1024 ** 2;

const MEMINFO = `MemTotal:       32794376 kB
MemFree:         1048576 kB
MemAvailable:   25165824 kB
Buffers:          524288 kB
Cached:         12582912 kB
SwapTotal:      16777208 kB
SwapFree:        2170588 kB
`;

const SWAPUSAGE = "total = 8192.00M  used = 1024.00M  free = 7168.00M  (encrypted)";

test("a real reading is internally consistent", async () => {
	const sample = await readSwap();
	if (!sample.available) {
		// Legal where no swap source exists. The contract is that it is
		// explicit rather than a silent zero.
		assert.equal(sample.source, "unavailable");
		assert.ok(sample.detail && sample.detail.length > 0, "an unavailable sample must say why");
		return;
	}
	assert.notEqual(sample.source, "unavailable");
	assert.ok(sample.totalBytes >= 0);
	assert.ok(sample.usedBytes >= 0);
	assert.ok(sample.usedBytes <= sample.totalBytes, "used swap must not exceed total swap");
	if (sample.totalBytes > 0) {
		assert.ok(
			Math.abs(sample.usedFraction - sample.usedBytes / sample.totalBytes) < 1e-12,
			"fraction must agree with the byte counts",
		);
	} else {
		assert.equal(sample.usedFraction, 0, "no swap has no fraction");
	}
});

test("parseMeminfoSwap reads the two swap keys", () => {
	assert.deepEqual(parseMeminfoSwap(MEMINFO), {
		totalBytes: 16777208 * 1024,
		freeBytes: 2170588 * 1024,
	});
});

test("parseMeminfoSwap rejects output without both keys", () => {
	assert.equal(parseMeminfoSwap(""), null);
	assert.equal(parseMeminfoSwap("MemTotal: 1024 kB\nSwapFree: 0 kB\n"), null);
	assert.equal(parseMeminfoSwap("SwapTotal: 1024 kB\n"), null);
});

test("Linux computes used swap as total minus free", async () => {
	const sample = await readSwap({
		platform: "linux",
		readFileImpl: async () => MEMINFO,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "/proc/meminfo");
	assert.equal(sample.totalBytes, 16777208 * 1024);
	assert.equal(sample.usedBytes, (16777208 - 2170588) * 1024);
});

test("a machine with no swap configured is a reading, not a failure", async () => {
	const sample = await readSwap({
		platform: "linux",
		readFileImpl: async () => "SwapTotal: 0 kB\nSwapFree: 0 kB\n",
	});
	assert.equal(sample.available, true, "no swap is a fact the reader can report");
	assert.equal(sample.totalBytes, 0);
	assert.equal(sample.usedBytes, 0);
	assert.equal(sample.usedFraction, 0, "the fraction of nothing is zero, not NaN");
});

test("Linux reports unavailable rather than zero when the file cannot be read", async () => {
	const sample = await readSwap({
		platform: "linux",
		readFileImpl: async () => {
			throw new Error("ENOENT");
		},
	});
	assert.equal(sample.available, false);
	assert.equal(sample.source, "unavailable");
	assert.ok(sample.detail);
});

test("Linux reports unavailable when /proc/meminfo lacks the swap keys", async () => {
	const sample = await readSwap({
		platform: "linux",
		readFileImpl: async () => "MemTotal: 1024 kB\n",
	});
	assert.equal(sample.available, false);
});

test("parseSwapusage reads the sysctl fields and their units", () => {
	assert.deepEqual(parseSwapusage(SWAPUSAGE), { totalBytes: 8192 * MIB, usedBytes: 1024 * MIB });
	// KiB and GiB appear on machines with very small or very large swap.
	assert.deepEqual(parseSwapusage("total = 512.00K  used = 128.00K  free = 384.00K"), {
		totalBytes: 512 * 1024,
		usedBytes: 128 * 1024,
	});
	assert.deepEqual(parseSwapusage("total = 2.00G  used = 1.00G  free = 1.00G"), {
		totalBytes: 2 * 1024 ** 3,
		usedBytes: 1024 ** 3,
	});
});

test("parseSwapusage rejects output without both fields", () => {
	assert.equal(parseSwapusage(""), null);
	assert.equal(parseSwapusage("total = 8192.00M  free = 7168.00M"), null);
	assert.equal(parseSwapusage("total = 8192.00X  used = 1024.00X"), null);
});

test("macOS reads swap from vm.swapusage", async () => {
	const sample = await readSwap({
		platform: "darwin",
		execFileImpl: async () => SWAPUSAGE,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "vm.swapusage");
	assert.equal(sample.totalBytes, 8192 * MIB);
	assert.equal(sample.usedBytes, 1024 * MIB);
});

test("macOS reports unavailable when sysctl fails", async () => {
	const sample = await readSwap({
		platform: "darwin",
		execFileImpl: async () => {
			throw new Error("not found");
		},
	});
	assert.equal(sample.available, false);
});

test("an unsupported platform reports unavailable", async () => {
	const sample = await readSwap({ platform: "win32" });
	assert.equal(sample.available, false);
	assert.equal(sample.source, "unavailable");
	assert.match(String(sample.detail), /win32/);
});

test("used swap is clamped to the installed total", async () => {
	// A negative free reading, or accounting that is briefly inconsistent,
	// must not produce more swap in use than exists.
	const sample = await readSwap({
		platform: "linux",
		readFileImpl: async () => "SwapTotal: 1024 kB\nSwapFree: 4096 kB\n",
	});
	assert.equal(sample.available, true);
	assert.equal(sample.usedBytes, 0, "free above total means nothing is in use, not negative usage");
});
