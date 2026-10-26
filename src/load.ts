/**
 * Cross-platform system load average reader.
 *
 * Primary path is os.loadavg(), which exists on Linux, macOS and the BSDs.
 * Two fallbacks cover the cases where it is absent or returns nothing usable:
 * /proc/loadavg on Linux, and `sysctl vm.loadavg` on macOS and the BSDs.
 *
 * On Windows os.loadavg() returns [0, 0, 0] rather than throwing, which would
 * read as a permanently idle machine and make the hook look healthy while
 * blind. That case is reported as unavailable instead.
 */

import { loadavg } from "node:os";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LoadSource = "os.loadavg" | "/proc/loadavg" | "sysctl" | "unavailable";

export type LoadSample = {
	/** False when no source could produce usable numbers. Never guess a value. */
	available: boolean;
	/** 1-minute load average. 0 when unavailable. */
	load1: number;
	/** 5-minute load average. 0 when unavailable. */
	load5: number;
	/** 15-minute load average. 0 when unavailable. */
	load15: number;
	source: LoadSource;
	/** Why the sample is unavailable, for the status command. */
	detail?: string;
};

function triple(values: unknown): [number, number, number] | null {
	if (!Array.isArray(values) || values.length < 3) return null;
	const parsed = values.slice(0, 3).map((value) => Number(value));
	if (!parsed.every((value) => Number.isFinite(value) && value >= 0)) return null;
	return [parsed[0], parsed[1], parsed[2]];
}

async function fromOs(): Promise<[number, number, number] | null> {
	try {
		if (process.platform === "win32") return null;
		return triple(loadavg());
	} catch {
		return null;
	}
}

async function fromProc(): Promise<[number, number, number] | null> {
	try {
		const contents = await readFile("/proc/loadavg", "utf8");
		return triple(contents.trim().split(/\s+/));
	} catch {
		return null;
	}
}

async function fromSysctl(): Promise<[number, number, number] | null> {
	if (process.platform === "win32") return null;
	try {
		// macOS and BSD: "{ 1.82 2.01 2.10 }"
		const { stdout } = await execFileAsync("sysctl", ["-n", "vm.loadavg"], { timeout: 2000 });
		return triple(stdout.replace(/[{}]/g, " ").trim().split(/\s+/));
	} catch {
		return null;
	}
}

/**
 * Read the current load averages. Never throws: a failure to read load is
 * reported as `available: false` so callers can stay quiet rather than guess.
 */
export async function readLoad(): Promise<LoadSample> {
	const attempts: Array<[LoadSource, () => Promise<[number, number, number] | null>]> = [
		["os.loadavg", fromOs],
		["/proc/loadavg", fromProc],
		["sysctl", fromSysctl],
	];

	for (const [source, attempt] of attempts) {
		const values = await attempt();
		if (values) {
			return { available: true, load1: values[0], load5: values[1], load15: values[2], source };
		}
	}

	return {
		available: false,
		load1: 0,
		load5: 0,
		load15: 0,
		source: "unavailable",
		detail: `no load source answered on ${process.platform}`,
	};
}