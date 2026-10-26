/**
 * The memory sampler.
 *
 * The awkward cases here are the ones that would otherwise produce a
 * confident wrong number: a cgroup that reports free memory above total, a
 * platform that hands back something implausible, and a page cache full of
 * reclaimable pages. All must either report the platform's own accounting of
 * "in use" or report `available: false`, never a fraction that looks real but
 * counts reclaimable cache as consumed.
 *
 * The parsers are exercised directly with captured command output so the
 * macOS and Linux paths stay covered on any host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { totalmem, freemem } from "node:os";

import { readMemory, formatBytes, parseVmStat, parseMeminfo } from "../src/memory.ts";

const GIB = 1024 ** 3;

/** A vm_stat capture with a warm page cache: most memory is inactive or
 *  file-backed, which is reclaimable and must not count as in use. */
const VM_STAT_WARM_CACHE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   474862.
Pages active:                                3310791.
Pages inactive:                              3174036.
Pages speculative:                            161445.
Pages throttled:                                   0.
Pages wired down:                             772411.
Pages purgeable:                               32253.
"Translation faults":                   111228345719.
Pages copy-on-write:                     21389227769.
Pages zero filled:                       34520240288.
Pages reactivated:                          35958031.
Pages purged:                               33721679.
File-backed pages:                           1730021.
Anonymous pages:                             4916251.
Pages stored in compressor:                  1423076.
Pages occupied by compressor:                 432033.
Decompressions:                             38860740.
Compressions:                               22629036.
Pageins:                                   648100460.
Pageouts:                                      38765.
Swapins:                                       18769.
Swapouts:                                      223324.
`;

const MEMINFO = `MemTotal:       32794376 kB
MemFree:         1048576 kB
MemAvailable:   25165824 kB
Buffers:          524288 kB
Cached:         12582912 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB
`;

test("a real reading is available and internally consistent", async () => {
	const sample = await readMemory();
	assert.equal(sample.available, true);
	assert.notEqual(sample.source, "unavailable");
	assert.ok(sample.totalBytes > 0, "total memory must be positive");
	assert.ok(sample.usedBytes >= 0, "used memory must not be negative");
	assert.ok(sample.usedBytes <= sample.totalBytes, "used memory must not exceed total");
	assert.ok(
		Math.abs(sample.usedFraction - sample.usedBytes / sample.totalBytes) < 1e-12,
		"fraction must agree with the byte counts",
	);
});

test("the total matches what the platform reports", async () => {
	const sample = await readMemory();
	assert.equal(sample.totalBytes, totalmem());
});

test("a real reading does not count reclaimable cache as used", async () => {
	const sample = await readMemory();
	if (!sample.available) return;
	// The old formula was total - freemem. On a machine with a warm cache that
	// reads far too high, which is the bug this guards.
	const naive = totalmem() - freemem();
	assert.ok(
		sample.usedBytes <= naive,
		`used ${sample.usedBytes} must not exceed the naive total-freemem figure ${naive}`,
	);
});

test("parseVmStat sums anonymous, wired and compressed pages", () => {
	const parsed = parseVmStat(VM_STAT_WARM_CACHE);
	assert.ok(parsed, "a valid capture must parse");
	assert.equal(parsed.pageSize, 16384);
	assert.equal(parsed.usedBytes, (4916251 + 772411 + 432033) * 16384);
});

test("parseVmStat rejects output that does not name its pages", () => {
	assert.equal(parseVmStat(""), null);
	assert.equal(parseVmStat("hello world\n"), null);
	assert.equal(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\n"), null);
});

test("macOS reads used memory from vm_stat", async () => {
	const sample = await readMemory({
		platform: "darwin",
		totalBytesImpl: () => 128 * GIB,
		execFileImpl: async () => VM_STAT_WARM_CACHE,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "vm_stat");
	assert.equal(sample.usedBytes, (4916251 + 772411 + 432033) * 16384);
});

test("macOS falls back to os.freemem when vm_stat fails", async () => {
	const sample = await readMemory({
		platform: "darwin",
		totalBytesImpl: () => 32 * GIB,
		freeBytesImpl: () => 8 * GIB,
		execFileImpl: async () => {
			throw new Error("vm_stat not found");
		},
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "node:os");
	assert.equal(sample.usedBytes, 24 * GIB);
});

test("Linux reads used memory from MemTotal minus MemAvailable", async () => {
	const sample = await readMemory({
		platform: "linux",
		// Deliberately unlike MemTotal, the way a cgroup limit can be.
		totalBytesImpl: () => 64 * GIB,
		readFileImpl: async () => MEMINFO,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "/proc/meminfo");
	assert.equal(sample.usedBytes, (32794376 - 25165824) * 1024);
	// The fraction must divide by MemTotal, the same total used to derive the
	// reading, even when os.totalmem() disagrees under a container.
	assert.equal(sample.totalBytes, 32794376 * 1024);
	assert.ok(Math.abs(sample.usedFraction - sample.usedBytes / (32794376 * 1024)) < 1e-12);
});

test("Linux falls back when /proc/meminfo has no MemAvailable", async () => {
	const sample = await readMemory({
		platform: "linux",
		totalBytesImpl: () => 32 * GIB,
		freeBytesImpl: () => 10 * GIB,
		readFileImpl: async () => "MemTotal: 32794376 kB\nMemFree: 1048576 kB\n",
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "node:os");
	assert.equal(sample.usedBytes, 22 * GIB);
});

test("an unsupported platform uses os.freemem", async () => {
	const sample = await readMemory({
		platform: "win32",
		totalBytesImpl: () => 16 * GIB,
		freeBytesImpl: () => 4 * GIB,
	});
	assert.equal(sample.available, true);
	assert.equal(sample.source, "node:os");
	assert.equal(sample.usedBytes, 12 * GIB);
});

test("parseMeminfo reads the two keys it needs", () => {
	assert.deepEqual(parseMeminfo(MEMINFO), { totalBytes: 32794376 * 1024, availableBytes: 25165824 * 1024 });
	assert.equal(parseMeminfo(""), null);
	assert.equal(parseMeminfo("MemTotal: 1 kB\n"), null);
});

test("formatBytes renders binary units", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(2048), "2 KiB");
	assert.equal(formatBytes(5 * 1024 ** 2), "5 MiB");
	assert.equal(formatBytes(32 * 1024 ** 3), "32.0 GiB");
});

test("formatBytes refuses to invent a number", () => {
	assert.equal(formatBytes(Number.NaN), "unknown");
	assert.equal(formatBytes(-1), "unknown");
});
