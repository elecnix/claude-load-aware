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

export type LoadReaderOptions = {
	/** Overrides process.platform. Injected for tests. */
	platform?: NodeJS.Platform;
	/** Injected for tests. Defaults to os.loadavg. */
	loadavgImpl?: () => number[];
	/** Injected for tests. Defaults to fs.readFile(path, "utf8"). */
	readFileImpl?: (path: string) => Promise<string>;
	/** Injected for tests. Returns stdout. Defaults to execFile with a 2 second timeout. */
	execFileImpl?: (file: string, args: string[]) => Promise<string>;
};

function triple(values: unknown): [number, number, number] | null {
	if (!Array.isArray(values) || values.length < 3) return null;
	const parsed = values.slice(0, 3).map((value) => Number(value));
	if (!parsed.every((value) => Number.isFinite(value) && value >= 0)) return null;
	return [parsed[0], parsed[1], parsed[2]];
}

async function fromOs(options: LoadReaderOptions): Promise<[number, number, number] | null> {
	try {
		if ((options.platform ?? process.platform) === "win32") return null;
		return triple((options.loadavgImpl ?? loadavg)());
	} catch {
		return null;
	}
}

async function fromProc(options: LoadReaderOptions): Promise<[number, number, number] | null> {
	try {
		const read = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
		const contents = await read("/proc/loadavg");
		return triple(contents.trim().split(/\s+/));
	} catch {
		return null;
	}
}

async function fromSysctl(options: LoadReaderOptions): Promise<[number, number, number] | null> {
	if ((options.platform ?? process.platform) === "win32") return null;
	try {
		// macOS and BSD: "{ 1.82 2.01 2.10 }"
		const run =
			options.execFileImpl ??
			(async (file: string, args: string[]) => (await execFileAsync(file, args, { timeout: 2000 })).stdout);
		const stdout = await run("sysctl", ["-n", "vm.loadavg"]);
		return triple(stdout.replace(/[{}]/g, " ").trim().split(/\s+/));
	} catch {
		return null;
	}
}

/**
 * Read the current load averages. Never throws: a failure to read load is
 * reported as `available: false` so callers can stay quiet rather than guess.
 */
export async function readLoad(options: LoadReaderOptions = {}): Promise<LoadSample> {
	const attempts: Array<[LoadSource, () => Promise<[number, number, number] | null>]> = [
		["os.loadavg", () => fromOs(options)],
		["/proc/loadavg", () => fromProc(options)],
		["sysctl", () => fromSysctl(options)],
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
		detail: `no load source answered on ${options.platform ?? process.platform}`,
	};
}