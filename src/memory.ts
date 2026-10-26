/**
 * Physical memory reader.
 *
 * Reports one number: how much of the machine's RAM is in use, using the
 * platform's own definition of "in use" rather than a naive subtraction.
 *
 * `os.freemem()` alone is not enough. On macOS it counts only truly-free
 * pages, so inactive and file-backed pages — reclaimable page cache — read as
 * in use and a healthy machine with a warm cache reports a fraction near
 * saturation. On Linux it returns `MemFree`, which has the same blind spot for
 * page cache. Both platforms expose a better figure:
 *
 *   - macOS: `vm_stat`, where used memory is anonymous plus wired plus
 *     compressed pages. That is the same arithmetic Activity Monitor displays,
 *     and it leaves cache out because cache is free to reclaim.
 *   - Linux: `/proc/meminfo`, where `MemTotal - MemAvailable` is the kernel's
 *     own estimate of memory in use, with reclaimable cache excluded.
 *
 * Every platform-specific source can fail, and `totalmem() - freemem()` is the
 * fallback. The `source` field always names the source the sample came from,
 * so a caller reading a surprising number can see which path produced it.
 *
 * The hook is read-only, so this module only ever observes — it never
 * allocates, frees, or touches another process.
 */

import { totalmem, freemem } from "node:os";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The byte formatter lives in format.ts so swap.ts can share it; re-exported
// here because it was part of this module's surface first.
export { formatBytes } from "./format.ts";

const execFileAsync = promisify(execFile);

export type MemorySource = "vm_stat" | "/proc/meminfo" | "node:os" | "unavailable";

export type MemorySample = {
	/** False when no source could produce usable numbers. Never guess a value. */
	available: boolean;
	totalBytes: number;
	usedBytes: number;
	/** usedBytes / totalBytes, clamped to [0, 1]. 0 when unavailable. */
	usedFraction: number;
	source: MemorySource;
	/** Why the sample is unavailable. */
	detail?: string;
};

export type MemoryReaderOptions = {
	/** Overrides process.platform. Injected for tests. */
	platform?: NodeJS.Platform;
	/** Injected for tests. Defaults to os.totalmem. */
	totalBytesImpl?: () => number;
	/** Injected for tests. Defaults to os.freemem. */
	freeBytesImpl?: () => number;
	/** Injected for tests. Defaults to fs.readFile(path, "utf8"). */
	readFileImpl?: (path: string) => Promise<string>;
	/** Injected for tests. Returns stdout. Defaults to execFile("vm_stat"). */
	execFileImpl?: (file: string, args: string[]) => Promise<string>;
};

/** Clamp to [0, total] so rounding and cgroup accounting cannot produce a
 *  negative or over-total used figure. */
function clamp(value: number, total: number): number {
	return Math.min(Math.max(value, 0), total);
}

function unavailable(detail: string): MemorySample {
	return { available: false, totalBytes: 0, usedBytes: 0, usedFraction: 0, source: "unavailable", detail };
}

function sample(totalBytes: number, usedBytes: number, source: MemorySource): MemorySample {
	const used = clamp(usedBytes, totalBytes);
	return { available: true, totalBytes, usedBytes: used, usedFraction: used / totalBytes, source };
}

export type VmStatCounts = {
	pageSize: number;
	usedBytes: number;
};

/**
 * Parse `vm_stat` output into the used-memory figure Activity Monitor shows:
 * anonymous plus wired plus compressed pages.
 *
 * Returns null when the capture does not name its page size or any of the
 * three counts, rather than treating a missing key as zero and under-reporting.
 */
export function parseVmStat(output: string): VmStatCounts | null {
	const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
	if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

	const pages = (label: string): number | null => {
		const match = new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(output);
		if (!match) return null;
		const value = Number(match[1]);
		return Number.isFinite(value) ? value : null;
	};

	const anonymous = pages("Anonymous pages");
	const wired = pages("Pages wired down");
	const compressor = pages("Pages occupied by compressor");
	if (anonymous === null || wired === null || compressor === null) return null;

	return { pageSize, usedBytes: (anonymous + wired + compressor) * pageSize };
}

export type MeminfoCounts = {
	totalBytes: number;
	availableBytes: number;
};

/**
 * Parse `/proc/meminfo` for the two keys that give memory in use. Returns null
 * when either is absent; an older kernel without `MemAvailable` falls back
 * rather than reporting `MemFree` as if it were the same thing.
 */
export function parseMeminfo(output: string): MeminfoCounts | null {
	const kb = (key: string): number | null => {
		const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(output);
		if (!match) return null;
		const value = Number(match[1]);
		return Number.isFinite(value) ? value : null;
	};

	const total = kb("MemTotal");
	const available = kb("MemAvailable");
	if (total === null || available === null) return null;

	return { totalBytes: total * 1024, availableBytes: available * 1024 };
}

/** Mirrors the hook's debug switch so a fallback is not silent when
 *  someone turns diagnostics on. */
function debugEnabled(): boolean {
	return process.env.CLAUDE_LOAD_AWARE_DEBUG === "1";
}

async function darwinUsedBytes(options: MemoryReaderOptions): Promise<number | null> {
	const run = options.execFileImpl ?? (async (file: string, args: string[]) => {
		const { stdout } = await execFileAsync(file, args, { timeout: 2000 });
		return stdout;
	});
	try {
		const parsed = parseVmStat(await run("vm_stat", []));
		return parsed ? parsed.usedBytes : null;
	} catch (error) {
		if (debugEnabled()) console.error(`[claude-load-aware] vm_stat unavailable: ${(error as Error).message}`);
		return null;
	}
}

async function linuxUsedBytes(
	options: MemoryReaderOptions,
): Promise<{ usedBytes: number; totalBytes: number } | null> {
	const read = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
	try {
		const parsed = parseMeminfo(await read("/proc/meminfo"));
		if (!parsed) return null;
		// Report MemTotal alongside the reading so the fraction below shares its
		// denominator. os.totalmem() and MemTotal can differ slightly under a
		// container, and mixing the two would skew the percentage.
		return { usedBytes: parsed.totalBytes - parsed.availableBytes, totalBytes: parsed.totalBytes };
	} catch {
		return null;
	}
}

/**
 * Read physical memory in use. Never throws: a failure to read memory is
 * reported as `available: false` so callers can stay quiet rather than guess.
 */
export async function readMemory(options: MemoryReaderOptions = {}): Promise<MemorySample> {
	const platform = options.platform ?? process.platform;
	const totalBytesImpl = options.totalBytesImpl ?? totalmem;
	const freeBytesImpl = options.freeBytesImpl ?? freemem;

	let total: number;
	try {
		total = totalBytesImpl();
	} catch (error) {
		return unavailable(`memory read failed: ${(error as Error).message}`);
	}
	if (!Number.isFinite(total) || total <= 0) {
		return unavailable(`implausible memory reading: total=${total}`);
	}

	if (platform === "darwin") {
		const used = await darwinUsedBytes(options);
		if (used !== null) return sample(total, used, "vm_stat");
	}
	if (platform === "linux") {
		const reading = await linuxUsedBytes(options);
		if (reading) return sample(reading.totalBytes, reading.usedBytes, "/proc/meminfo");
	}

	let free: number;
	try {
		free = freeBytesImpl();
	} catch (error) {
		return unavailable(`memory read failed: ${(error as Error).message}`);
	}
	if (!Number.isFinite(free) || free < 0) {
		return unavailable(`implausible memory reading: total=${total}, free=${free}`);
	}

	// free() can exceed total() under container cgroup accounting on Linux, and
	// rounding at the boundary can push it one byte over. Clamp rather than
	// report a negative used-bytes figure.
	return sample(total, total - free, "node:os");
}
