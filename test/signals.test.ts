/**
 * Band arithmetic and the hysteresis that keeps a boundary value quiet.
 *
 * The band machine is shared by both watched signals, so it is tested once
 * here against raw numbers. The hook test covers the wiring.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	nextBand,
	isCrossing,
	bandIndex,
	enterThreshold,
	exitThreshold,
	BANDS,
	DEFAULT_BAND_CONFIG,
	type BandConfig,
} from "../src/signals.ts";

const CONFIG: BandConfig = { elevatedMultiplier: 1, highMultiplier: 1.5, hysteresis: 0.1 };
const THRESHOLD = 10;

test("bands are ordered quietest to noisiest", () => {
	assert.deepEqual([...BANDS], ["normal", "elevated", "high"]);
	assert.ok(bandIndex("normal") < bandIndex("elevated"));
	assert.ok(bandIndex("elevated") < bandIndex("high"));
});

test("entry points are the threshold scaled by each multiplier", () => {
	assert.equal(enterThreshold("normal", THRESHOLD, CONFIG), null);
	assert.equal(enterThreshold("elevated", THRESHOLD, CONFIG), 10);
	assert.equal(enterThreshold("high", THRESHOLD, CONFIG), 15);
});

test("exit points sit hysteresis below the entry point", () => {
	assert.equal(exitThreshold("normal", THRESHOLD, CONFIG), null);
	assert.equal(exitThreshold("elevated", THRESHOLD, CONFIG), 9);
	assert.equal(exitThreshold("high", THRESHOLD, CONFIG), 13.5);
});

test("a value below the threshold stays normal", () => {
	assert.equal(nextBand("normal", 9.99, THRESHOLD, CONFIG), "normal");
	assert.equal(nextBand("normal", 0, THRESHOLD, CONFIG), "normal");
});

test("crossing the entry point engages the band exactly at the boundary", () => {
	assert.equal(nextBand("normal", 10, THRESHOLD, CONFIG), "elevated");
	assert.equal(nextBand("normal", 15, THRESHOLD, CONFIG), "high");
});

test("escalation jumps straight to the band the sample justifies", () => {
	// A machine that goes from quiet to saturated is not made to ramp.
	assert.equal(nextBand("normal", 22, THRESHOLD, CONFIG), "high");
	assert.equal(nextBand("elevated", 22, THRESHOLD, CONFIG), "high");
});

test("hysteresis holds the band when the value dips inside the exit point", () => {
	// high entered at 15; 14 is above its 13.5 exit point.
	assert.equal(nextBand("high", 14, THRESHOLD, CONFIG), "high");
	// elevated entered at 10; 9.5 is above its 9.0 exit point.
	assert.equal(nextBand("elevated", 9.5, THRESHOLD, CONFIG), "elevated");
});

test("crossing the exit point releases exactly one band per step", () => {
	assert.equal(nextBand("high", 13.4, THRESHOLD, CONFIG), "elevated");
	assert.equal(nextBand("high", 8, THRESHOLD, CONFIG), "elevated");
	assert.equal(nextBand("elevated", 8.9, THRESHOLD, CONFIG), "normal");
});

test("a value inside the current band is a no-op", () => {
	assert.equal(nextBand("high", 30, THRESHOLD, CONFIG), "high");
	assert.equal(nextBand("elevated", 12, THRESHOLD, CONFIG), "elevated");
	assert.equal(nextBand("normal", 3, THRESHOLD, CONFIG), "normal");
});

test("a non-finite sample never changes the band", () => {
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.equal(nextBand("normal", bad, THRESHOLD, CONFIG), "normal", `from normal, value ${bad}`);
		assert.equal(nextBand("high", bad, THRESHOLD, CONFIG), "high", `from high, value ${bad}`);
	}
});

test("a non-positive or non-finite threshold never changes the band", () => {
	assert.equal(nextBand("normal", 99, 0, CONFIG), "normal");
	assert.equal(nextBand("normal", 99, -5, CONFIG), "normal");
	assert.equal(nextBand("normal", 99, Number.NaN, CONFIG), "normal");
});

test("isCrossing distinguishes a real change from a no-op", () => {
	assert.equal(isCrossing("normal", "high"), true);
	assert.equal(isCrossing("high", "normal"), true);
	assert.equal(isCrossing("high", "high"), false);
});

test("the same arithmetic serves a fractional signal such as memory", () => {
	// Memory passes a fraction against a fraction threshold; nothing about the
	// machine changes, only the units.
	const fraction = 0.8;
	assert.equal(nextBand("normal", fraction, 0.8, CONFIG), "elevated");
	assert.equal(nextBand("elevated", 0.75, 0.8, CONFIG), "elevated");
	assert.equal(nextBand("elevated", 0.71, 0.8, CONFIG), "normal");
});

test("the shipped defaults engage elevated at the threshold and high at 1.5x", () => {
	assert.equal(DEFAULT_BAND_CONFIG.elevatedMultiplier, 1);
	assert.equal(DEFAULT_BAND_CONFIG.highMultiplier, 1.5);
	assert.equal(DEFAULT_BAND_CONFIG.hysteresis, 0.1);
});
