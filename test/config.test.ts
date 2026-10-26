/**
 * Config resolution for the swap and I/O pressure thresholds.
 *
 * The hook suite injects a finished `LoadAwareConfig`, which leaves the
 * environment and file resolution for these two settings unexercised. These
 * tests walk each one from an env var or the config file to a fraction, and
 * cover the out-of-range guard that replaces a bad value with the default.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, DEFAULTS, type LoadConfigOptions } from "../src/config.ts";

const CONFIG_PATH = "/tmp/does-not-exist/claude-load-aware.json";

/** A config file that is not there, so only env and defaults contribute. */
const noFile = async (): Promise<string> => {
	const error = new Error("ENOENT") as NodeJS.ErrnoException;
	error.code = "ENOENT";
	throw error;
};

function load(env: NodeJS.ProcessEnv, contents?: string, options: LoadConfigOptions = {}) {
	return loadConfig({
		env,
		configPath: CONFIG_PATH,
		readFileImpl: contents === undefined ? noFile : async () => contents,
		...options,
	});
}

test("the shipped defaults are a 50% swap threshold and a 20% I/O threshold", async () => {
	const config = await load({});
	assert.equal(config.swapThreshold, 0.5);
	assert.equal(config.ioThreshold, 0.2);
	assert.equal(config.swapThresholdSource, "default");
	assert.equal(config.ioThresholdSource, "default");
	assert.equal(DEFAULTS.swapThresholdPercent, 50);
	assert.equal(DEFAULTS.ioPressureThresholdPercent, 20);
	assert.deepEqual(config.warnings, []);
});

test("environment variables set both thresholds as percentages", async () => {
	const config = await load({
		CLAUDE_LOAD_AWARE_SWAP_THRESHOLD: "70",
		CLAUDE_LOAD_AWARE_IO_THRESHOLD: "35",
	});
	assert.equal(config.swapThreshold, 0.7);
	assert.equal(config.ioThreshold, 0.35);
	assert.equal(config.swapThresholdSource, "env");
	assert.equal(config.ioThresholdSource, "env");
});

test("the config file sets both thresholds when the environment is silent", async () => {
	const config = await load({}, JSON.stringify({ swapThresholdPercent: 30, ioPressureThresholdPercent: 5 }));
	assert.equal(config.swapThreshold, 0.3);
	assert.equal(config.ioThreshold, 0.05);
	assert.equal(config.swapThresholdSource, "file");
	assert.equal(config.ioThresholdSource, "file");
});

test("an environment value wins over the config file", async () => {
	const config = await load(
		{ CLAUDE_LOAD_AWARE_SWAP_THRESHOLD: "60" },
		JSON.stringify({ swapThresholdPercent: 30, ioPressureThresholdPercent: 40 }),
	);
	assert.equal(config.swapThreshold, 0.6, "env beats file");
	assert.equal(config.swapThresholdSource, "env");
	assert.equal(config.ioThreshold, 0.4, "the file still supplies the other one");
	assert.equal(config.ioThresholdSource, "file");
});

test("a threshold outside (0, 100] warns and falls back to the default", async () => {
	for (const percent of ["0", "-5", "101"]) {
		const config = await load({ CLAUDE_LOAD_AWARE_SWAP_THRESHOLD: percent, CLAUDE_LOAD_AWARE_IO_THRESHOLD: percent });
		assert.equal(config.swapThreshold, 0.5, `swap ${percent}`);
		assert.equal(config.ioThreshold, 0.2, `io ${percent}`);
		assert.equal(config.warnings.length, 2, `both warnings for ${percent}`);
	}
});

test("a rejected value reports the default as its source, not where it came from", async () => {
	// The env var is out of range, so the number in use is the default. Saying
	// "env" would claim the environment supplied a value it did not.
	const config = await load({
		CLAUDE_LOAD_AWARE_MEMORY_THRESHOLD: "0",
		CLAUDE_LOAD_AWARE_SWAP_THRESHOLD: "150",
		CLAUDE_LOAD_AWARE_IO_THRESHOLD: "0",
	});
	assert.equal(config.memoryThreshold, 0.8);
	assert.equal(config.memoryThresholdSource, "default");
	assert.equal(config.swapThreshold, 0.5);
	assert.equal(config.swapThresholdSource, "default");
	assert.equal(config.ioThreshold, 0.2);
	assert.equal(config.ioThresholdSource, "default");

	// The load threshold is rejected on the same rule, and reports the same way.
	const rejectedLoad = await load({ CLAUDE_LOAD_AWARE_LOAD_THRESHOLD: "0" });
	assert.equal(rejectedLoad.loadThreshold, DEFAULTS.loadThreshold);
	assert.equal(rejectedLoad.loadThresholdSource, "default");

	// The same rule through the file path.
	const fromFile = await load(
		{},
		JSON.stringify({ memoryThresholdPercent: 0, swapThresholdPercent: 0, ioPressureThresholdPercent: 0 }),
	);
	assert.equal(fromFile.memoryThresholdSource, "default");
	assert.equal(fromFile.swapThresholdSource, "default");
	assert.equal(fromFile.ioThresholdSource, "default");
});

test("a non-numeric environment value is ignored, not treated as zero", async () => {
	const config = await load({ CLAUDE_LOAD_AWARE_SWAP_THRESHOLD: "half" });
	assert.equal(config.swapThreshold, 0.5);
	assert.equal(config.swapThresholdSource, "default");
});

test("the cache directory defaults under XDG_CACHE_HOME, then ~/.cache", async () => {
	const xdg = await load({ XDG_CACHE_HOME: "/tmp/xdg-example" });
	assert.equal(xdg.cacheDir, "/tmp/xdg-example/claude-load-aware");
	const home = await load({});
	assert.match(home.cacheDir, /\/\.cache\/claude-load-aware$/);
});

test("the cache directory takes the file value, and the environment wins over the file", async () => {
	const fromFile = await load({}, JSON.stringify({ cacheDir: "/tmp/from-file" }));
	assert.equal(fromFile.cacheDir, "/tmp/from-file");
	const fromEnv = await load({ CLAUDE_LOAD_AWARE_CACHE_DIR: "/tmp/from-env" }, JSON.stringify({ cacheDir: "/tmp/from-file" }));
	assert.equal(fromEnv.cacheDir, "/tmp/from-env");
});

test("the config path comes from CLAUDE_LOAD_AWARE_CONFIG", async () => {
	const seen: string[] = [];
	await loadConfig({
		env: { CLAUDE_LOAD_AWARE_CONFIG: "/tmp/elsewhere.json" },
		readFileImpl: async (path) => {
			seen.push(path);
			return "{}";
		},
	});
	assert.deepEqual(seen, ["/tmp/elsewhere.json"]);
});

test("the enabled switch follows environment over file over default", async () => {
	assert.equal((await load({})).enabled, true);
	assert.equal((await load({}, JSON.stringify({ enabled: false }))).enabled, false);
	assert.equal((await load({ CLAUDE_LOAD_AWARE_ENABLED: "1" }, JSON.stringify({ enabled: false }))).enabled, true);
	assert.equal((await load({ CLAUDE_LOAD_AWARE_ENABLED: "off" })).enabled, false);
});

test("hysteresis, load and memory resolve with the same precedence", async () => {
	const file = JSON.stringify({ hysteresis: 0.2, loadThreshold: 3, memoryThresholdPercent: 70 });
	const fromFile = await load({}, file);
	assert.equal(fromFile.hysteresis, 0.2);
	assert.equal(fromFile.loadThreshold, 3);
	assert.equal(fromFile.memoryThreshold, 0.7);
	const fromEnv = await load(
		{ CLAUDE_LOAD_AWARE_HYSTERESIS: "0.3", CLAUDE_LOAD_AWARE_LOAD_THRESHOLD: "6", CLAUDE_LOAD_AWARE_MEMORY_THRESHOLD: "90" },
		file,
	);
	assert.equal(fromEnv.hysteresis, 0.3);
	assert.equal(fromEnv.loadThreshold, 6);
	assert.equal(fromEnv.memoryThreshold, 0.9);
	assert.equal((await load({ CLAUDE_LOAD_AWARE_HYSTERESIS: "1.5" })).warnings.length, 1);
});

test("a malformed config file is reported and the defaults stay", async () => {
	const config = await load({}, "{broken");
	assert.equal(config.warnings.length, 1);
	assert.equal(config.swapThreshold, 0.5);
});
