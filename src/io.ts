/**
 * Disk I/O contention reader, from Linux PSI (Pressure Stall Information).
 *
 * The measure is the kernel's own stall accounting in `/proc/pressure/io`:
 * the share of wall time in which tasks were waiting on I/O rather than
 * running. That is the pressure itself, not a proxy for it.
 *
 * The alternatives are all misleading by comparison:
 *
 *   - Throughput (bytes/s or IOPS) says how much work is moving, not whether
 *     anything is waiting. A saturated NVMe and a dying disk can move the same
 *     number.
 *   - `%util` / `%busy` says a device had a request in flight, which on a
 *     queueing device is true long before latency suffers and says nothing
 *     about whether a task was blocked.
 *   - `iowait` from `/proc/stat` overcounts: it includes idle time that
 *     happened to overlap an outstanding request and misses stalls on tasks
 *     that were runnable elsewhere. The kernel documents it as unreliable.
 *
 * PSI `some` is the band driver: it is the broader figure — the time any task
 * was stalled — so `full` (the time every task was stalled) can never exceed
 * it. A machine with heavy `full` stalls necessarily has high `some`, which
 * makes `some` the safe single trigger and `full` the severity detail.
 *
 * PSI is Linux-only. macOS and Windows publish no equivalent accounting, and
 * a utilization or queue-depth number would answer a different question, so
 * those platforms report `available: false` rather than a stand-in.
 */

import { readFile } from "node:fs/promises";

export type IoPressureSource = "/proc/pressure/io" | "unavailable";

export type IoPressureSample = {
	/** False when no source could produce usable numbers. Never guess a value. */
	available: boolean;
	/** `some avg10` as a fraction of wall time: at least one task stalled on I/O. */
	some10: number;
	/** `full avg10` as a fraction, or null when the kernel did not report it. */
	full10: number | null;
	source: IoPressureSource;
	/** Why the sample is unavailable. */
	detail?: string;
};

export type IoPressureReaderOptions = {
	/** Overrides process.platform. Injected for tests. */
	platform?: NodeJS.Platform;
	/** Injected for tests. Defaults to fs.readFile(path, "utf8"). */
	readFileImpl?: (path: string) => Promise<string>;
};

/** One `some` or `full` line of a PSI file. Averages are percentages, so
 *  `avg10` may exceed 100 only if the kernel reports it that way. */
export type PressureAverages = {
	avg10: number;
	avg60: number;
	avg300: number;
	totalMicros: number;
};

function pressureLine(output: string, kind: "some" | "full"): PressureAverages | null {
	const match = new RegExp(
		`^${kind}\\s+avg10=([0-9.]+)\\s+avg60=([0-9.]+)\\s+avg300=([0-9.]+)\\s+total=(\\d+)`,
		"m",
	).exec(output);
	if (!match) return null;

	const [avg10, avg60, avg300, total] = match.slice(1).map(Number);
	if (![avg10, avg60, avg300, total].every((value) => Number.isFinite(value) && value >= 0)) return null;

	return { avg10, avg60, avg300, totalMicros: total };
}

/**
 * Parse `/proc/pressure/io`. Returns null when the `some` line is absent or
 * unparsable; a missing `full` line is tolerated because it is supplementary.
 */
export function parsePressure(output: string): { some: PressureAverages; full: PressureAverages | null } | null {
	const some = pressureLine(output, "some");
	if (!some) return null;
	return { some, full: pressureLine(output, "full") };
}

function unavailable(detail: string): IoPressureSample {
	return { available: false, some10: 0, full10: null, source: "unavailable", detail };
}

/**
 * Read disk I/O pressure. Never throws: a missing or unreadable PSI file is
 * reported as `available: false` so callers can stay quiet rather than guess.
 */
export async function readIoPressure(options: IoPressureReaderOptions = {}): Promise<IoPressureSample> {
	const platform = options.platform ?? process.platform;
	if (platform !== "linux") {
		return unavailable(`no pressure stall accounting on ${platform}`);
	}

	const read = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
	try {
		const parsed = parsePressure(await read("/proc/pressure/io"));
		if (!parsed) return unavailable("/proc/pressure/io reported no some avg10");
		return {
			available: true,
			some10: parsed.some.avg10 / 100,
			full10: parsed.full ? parsed.full.avg10 / 100 : null,
			source: "/proc/pressure/io",
		};
	} catch (error) {
		return unavailable(`/proc/pressure/io unavailable: ${(error as Error).message}`);
	}
}
