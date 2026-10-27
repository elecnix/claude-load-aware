/**
 * Configuration: defaults, optional JSON file, environment overrides.
 *
 * Precedence is defaults < config file < environment. The file is optional; a
 * missing or malformed file is not fatal, it leaves the defaults in place and
 * is reported through `warnings`.
 *
 * Each watched signal carries its own threshold, and the two are independent:
 * load is configured in load-average units (roughly runnable threads) and
 * memory as a percentage of installed RAM.
 */

import { cpus, availableParallelism } from "node:os";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { DEFAULT_BAND_CONFIG, type BandConfig } from "./signals.ts";

export type ThresholdSource = "default" | "file" | "env";

export type LoadAwareConfig = BandConfig & {
	/** 1-minute load average at which the `elevated` band engages. */
	loadThreshold: number;
	/** Fraction of installed RAM in use at which the `elevated` band engages, 0-1. */
	memoryThreshold: number;
	/** Fraction of swap in use at which the `elevated` band engages, 0-1. */
	swapThreshold: number;
	/** Fraction of wall time stalled on I/O at which the `elevated` band engages, 0-1. */
	ioThreshold: number;
	/** Master switch. When false the hook exits before sampling and adds no context. */
	enabled: boolean;
	loadThresholdSource: ThresholdSource;
	memoryThresholdSource: ThresholdSource;
	swapThresholdSource: ThresholdSource;
	ioThresholdSource: ThresholdSource;
	/** Directory that holds per-session band state between hook invocations. */
	cacheDir: string;
	/** Non-fatal problems found while loading config. */
	warnings: string[];
};

/** XDG cache home when set, else `~/.cache`, then this tool's own directory. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim() !== "" ? env.XDG_CACHE_HOME : `${homedir()}/.cache`;
	return `${base}/claude-load-aware`;
}

const DEFAULT_CONFIG_PATH = `${homedir()}/.config/claude-load-aware/config.json`;

/**
 * Logical CPU count. Drives the default load threshold, and is reported in
 * every message so the reader can see load against core count.
 */
export function cpuCount(): number {
	const parallel = typeof availableParallelism === "function" ? availableParallelism() : 0;
	const count = parallel > 0 ? parallel : cpus().length;
	return count > 0 ? count : 1;
}

export const DEFAULTS = {
	/** One load unit per logical CPU: at this value the machine has as many
	 *  runnable threads as it has cores. */
	loadThreshold: cpuCount(),
	/** 80% of installed RAM. */
	memoryThresholdPercent: 80,
	/** Half of installed swap. Swap fills and does not drain on its own, so the
	 *  default is set below the memory one to say something before the machine
	 *  is close to running out of backing store. */
	swapThresholdPercent: 50,
	/** 20% of wall time with at least one task stalled on I/O. */
	ioPressureThresholdPercent: 20,
	enabled: true,
} as const;

function numberFrom(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function boolFrom(value: string | undefined): boolean | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["0", "false", "off", "no"].includes(normalized)) return false;
	if (["1", "true", "on", "yes"].includes(normalized)) return true;
	return undefined;
}

export type LoadConfigOptions = {
	env?: NodeJS.ProcessEnv;
	/** Overrides the default config file location. */
	configPath?: string;
	/** Injected for tests. */
	readFileImpl?: (path: string) => Promise<string>;
};

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadAwareConfig> {
	const env = options.env ?? process.env;
	const readFileImpl = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
	const configPath = options.configPath ?? env.CLAUDE_LOAD_AWARE_CONFIG ?? DEFAULT_CONFIG_PATH;

	const warnings: string[] = [];
	let fileValues: Record<string, unknown> = {};

	try {
		const parsed: unknown = JSON.parse(await readFileImpl(configPath));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			fileValues = parsed as Record<string, unknown>;
		} else {
			warnings.push(`ignoring ${configPath}: expected a JSON object`);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			warnings.push(`ignoring ${configPath}: ${(error as Error).message}`);
		}
	}

	const fileNumber = (key: string): number | undefined =>
		typeof fileValues[key] === "number" && Number.isFinite(fileValues[key] as number)
			? (fileValues[key] as number)
			: undefined;
	const fileBool = (key: string): boolean | undefined =>
		typeof fileValues[key] === "boolean" ? (fileValues[key] as boolean) : undefined;

	const loadEnv = numberFrom(env.CLAUDE_LOAD_AWARE_LOAD_THRESHOLD);
	const loadFile = fileNumber("loadThreshold");
	const loadThreshold = loadEnv ?? loadFile ?? DEFAULTS.loadThreshold;
	const loadThresholdSource: ThresholdSource =
		loadEnv !== undefined ? "env" : loadFile !== undefined ? "file" : "default";

	// A non-positive load threshold is rejected the same way an out-of-range
	// percentage is: the default replaces it, and the source says "default"
	// because that is the value in use.
	const loadRejected = loadThreshold <= 0;
	if (loadRejected) {
		warnings.push(`loadThreshold ${loadThreshold} is not positive; using default ${DEFAULTS.loadThreshold}`);
	}

	// Memory, swap and I/O pressure are each configured as a percentage of a
	// whole because that is how people reason about them, and stored as a
	// fraction because that is how they are compared. A value outside (0, 100]
	// is reported and replaced by the default, and the source then reads
	// "default" too: the number in use came from the default, and saying the
	// env var or the file supplied it would misreport where the threshold came
	// from.
	const fractionThreshold = (
		envValue: string | undefined,
		fileKey: string,
		defaultPercent: number,
		label: string,
	): { value: number; source: ThresholdSource } => {
		const envNumber = numberFrom(envValue);
		const fileNumberValue = fileNumber(fileKey);
		const percent = envNumber ?? fileNumberValue ?? defaultPercent;
		const source: ThresholdSource = envNumber !== undefined ? "env" : fileNumberValue !== undefined ? "file" : "default";
		if (percent <= 0 || percent > 100) {
			warnings.push(`${label} ${percent} outside (0, 100]; using default ${defaultPercent}`);
			return { value: defaultPercent / 100, source: "default" };
		}
		return { value: percent / 100, source };
	};

	const memory = fractionThreshold(
		env.CLAUDE_LOAD_AWARE_MEMORY_THRESHOLD,
		"memoryThresholdPercent",
		DEFAULTS.memoryThresholdPercent,
		"memoryThresholdPercent",
	);

	const hysteresis = numberFrom(env.CLAUDE_LOAD_AWARE_HYSTERESIS) ?? fileNumber("hysteresis");
	if (hysteresis !== undefined && (hysteresis < 0 || hysteresis >= 1)) {
		warnings.push(`hysteresis ${hysteresis} outside [0, 1); using default ${DEFAULT_BAND_CONFIG.hysteresis}`);
	}

	const enabled = boolFrom(env.CLAUDE_LOAD_AWARE_ENABLED) ?? fileBool("enabled") ?? DEFAULTS.enabled;

	const fileString = (key: string): string | undefined =>
		typeof fileValues[key] === "string" && (fileValues[key] as string).trim() !== ""
			? (fileValues[key] as string)
			: undefined;
	const envCacheDir = env.CLAUDE_LOAD_AWARE_CACHE_DIR;
	const cacheDir =
		(envCacheDir && envCacheDir.trim() !== "" ? envCacheDir : undefined) ?? fileString("cacheDir") ?? defaultCacheDir(env);

	const swap = fractionThreshold(
		env.CLAUDE_LOAD_AWARE_SWAP_THRESHOLD,
		"swapThresholdPercent",
		DEFAULTS.swapThresholdPercent,
		"swapThresholdPercent",
	);
	const io = fractionThreshold(
		env.CLAUDE_LOAD_AWARE_IO_THRESHOLD,
		"ioPressureThresholdPercent",
		DEFAULTS.ioPressureThresholdPercent,
		"ioPressureThresholdPercent",
	);

	return {
		loadThreshold: loadRejected ? DEFAULTS.loadThreshold : loadThreshold,
		loadThresholdSource: loadRejected ? "default" : loadThresholdSource,
		memoryThreshold: memory.value,
		memoryThresholdSource: memory.source,
		swapThreshold: swap.value,
		swapThresholdSource: swap.source,
		ioThreshold: io.value,
		ioThresholdSource: io.source,
		enabled,
		cacheDir,
		warnings,
		elevatedMultiplier: DEFAULT_BAND_CONFIG.elevatedMultiplier,
		highMultiplier: DEFAULT_BAND_CONFIG.highMultiplier,
		hysteresis:
			hysteresis !== undefined && hysteresis >= 0 && hysteresis < 1 ? hysteresis : DEFAULT_BAND_CONFIG.hysteresis,
	};
}
