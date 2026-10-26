/**
 * Swap usage reader.
 *
 * Reports one number: how much of the machine's swap is in use.
 *
 * Swap is the kernel's overflow for anonymous memory. Its fill level is a
 * state, not a rate — it rises when memory pressure forces pages out and does
 * not fall on its own — so a reading taken now is comparable with one taken
 * hours ago, and the reader holds no previous-sample state.
 *
 * Two platform sources:
 *
 *   - Linux: `/proc/meminfo`, where `SwapTotal - SwapFree` is swap in use.
 *     The memory reader parses the same file for RAM; this module reads it
 *     again for the swap keys so that a machine with no swap is never
 *     confused with a machine whose RAM could not be read.
 *   - macOS: `sysctl -n vm.swapusage`, which prints total, used and free in
 *     binary megabytes, optionally with an `(encrypted)` marker.
 *
 * A machine with no swap configured is not a failure. The read succeeds and
 * reports `totalBytes: 0`, which renders as "none configured" rather than as
 * a percentage of nothing. Every other inability to read is
 * `available: false`, so the band holds instead of moving on a guessed zero.
 */

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SwapSource = "/proc/meminfo" | "vm.swapusage" | "unavailable";

export type SwapSample = {
	/** False when no source could produce usable numbers. Never guess a value. */
	available: boolean;
	/** 0 when no swap is configured, which is a real reading rather than a failure. */
	totalBytes: number;
	usedBytes: number;
	/** usedBytes / totalBytes, clamped to [0, 1]. 0 when unavailable or unconfigured. */
	usedFraction: number;
	source: SwapSource;
	/** Why the sample is unavailable. */
	detail?: string;
};

export type SwapReaderOptions = {
	/** Overrides process.platform. Injected for tests. */
	platform?: NodeJS.Platform;
	/** Injected for tests. Defaults to fs.readFile(path, "utf8"). */
	readFileImpl?: (path: string) => Promise<string>;
	/** Injected for tests. Returns stdout. Defaults to execFile("sysctl", ["-n", "vm.swapusage"]). */
	execFileImpl?: (file: string, args: string[]) => Promise<string>;
};

/** Mirrors the hook's debug switch so a fallback is not silent when
 *  someone turns diagnostics on. */
function debugEnabled(): boolean {
	return process.env.CLAUDE_LOAD_AWARE_DEBUG === "1";
}

function unavailable(detail: string): SwapSample {
	return { available: false, totalBytes: 0, usedBytes: 0, usedFraction: 0, source: "unavailable", detail };
}

function sample(totalBytes: number, usedBytes: number, source: SwapSource): SwapSample {
	const total = Math.max(totalBytes, 0);
	// Clamp so rounding at the boundary cannot report more swap in use than is
	// installed, and guard the no-swap case against a 0/0 fraction.
	const used = Math.min(Math.max(usedBytes, 0), total);
	return {
		available: true,
		totalBytes: total,
		usedBytes: used,
		usedFraction: total > 0 ? used / total : 0,
		source,
	};
}

/**
 * Parse the swap keys of `/proc/meminfo`. Returns null when either key is
 * absent, rather than treating a missing total as "no swap": an unreadable
 * file and a machine with swap disabled are different facts.
 */
export function parseMeminfoSwap(output: string): { totalBytes: number; freeBytes: number } | null {
	const kb = (key: string): number | null => {
		const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(output);
		if (!match) return null;
		const value = Number(match[1]);
		return Number.isFinite(value) ? value : null;
	};

	const total = kb("SwapTotal");
	const free = kb("SwapFree");
	if (total === null || free === null) return null;

	return { totalBytes: total * 1024, freeBytes: free * 1024 };
}

const BINARY_UNITS: Record<string, number | undefined> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/**
 * Parse `sysctl -n vm.swapusage`. The line reads
 * `total = 8192.00M  used = 1234.56M  free = 6957.44M  (encrypted)`.
 * Returns null when total or used cannot be read with a known unit.
 */
export function parseSwapusage(output: string): { totalBytes: number; usedBytes: number } | null {
	const field = (label: string): number | null => {
		const match = new RegExp(`\\b${label} = ([0-9.]+)([KMG])`).exec(output);
		if (!match) return null;
		const value = Number(match[1]);
		const unit = BINARY_UNITS[match[2]];
		// The capture is limited to [KMG], so an unknown unit means the format
		// changed under us. Report nothing rather than multiply by undefined and
		// return NaN as a swap figure.
		if (!Number.isFinite(value) || unit === undefined) return null;
		return value * unit;
	};

	const total = field("total");
	const used = field("used");
	if (total === null || used === null) return null;

	return { totalBytes: total, usedBytes: used };
}

async function linuxSwap(options: SwapReaderOptions): Promise<{ totalBytes: number; usedBytes: number } | null> {
	const read = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
	try {
		const parsed = parseMeminfoSwap(await read("/proc/meminfo"));
		if (!parsed) return null;
		return { totalBytes: parsed.totalBytes, usedBytes: parsed.totalBytes - parsed.freeBytes };
	} catch (error) {
		if (debugEnabled()) console.error(`[claude-load-aware] /proc/meminfo swap unavailable: ${(error as Error).message}`);
		return null;
	}
}

async function darwinSwap(options: SwapReaderOptions): Promise<{ totalBytes: number; usedBytes: number } | null> {
	const run = options.execFileImpl ?? (async (file: string, args: string[]) => {
		const { stdout } = await execFileAsync(file, args, { timeout: 2000 });
		return stdout;
	});
	try {
		return parseSwapusage(await run("sysctl", ["-n", "vm.swapusage"]));
	} catch (error) {
		if (debugEnabled()) console.error(`[claude-load-aware] vm.swapusage unavailable: ${(error as Error).message}`);
		return null;
	}
}

/**
 * Read swap usage. Never throws: an unreadable swap figure is reported as
 * `available: false` so callers can stay quiet rather than guess.
 */
export async function readSwap(options: SwapReaderOptions = {}): Promise<SwapSample> {
	const platform = options.platform ?? process.platform;

	if (platform === "linux") {
		const reading = await linuxSwap(options);
		if (reading) return sample(reading.totalBytes, reading.usedBytes, "/proc/meminfo");
	}
	if (platform === "darwin") {
		const reading = await darwinSwap(options);
		if (reading) return sample(reading.totalBytes, reading.usedBytes, "vm.swapusage");
	}

	return unavailable(`no swap source answered on ${platform}`);
}
