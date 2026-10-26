/**
 * Band state machine shared by every signal this extension reports.
 *
 * A band is a neutral label for a range of a number: `normal`, `elevated`,
 * `high`. It carries no meaning about what should happen, and no action in
 * this tool is derived from it beyond deciding that a crossing occurred.
 *
 * The module is pure: no I/O, no Claude Code imports, no timers. Everything is a
 * deterministic function of (current band, one sample, config), which is what
 * makes the hysteresis testable without a running session.
 *
 * The machine is unit-agnostic. Load passes a raw 1-minute average against a
 * load threshold; memory passes a fraction in [0, 1] against a fraction
 * threshold. Same arithmetic, separate state.
 */

/** Ordered from quietest to noisiest. Index order is significant. */
export type Band = "normal" | "elevated" | "high";

export const BANDS: readonly Band[] = ["normal", "elevated", "high"];

export type BandConfig = {
	/** Value at which `elevated` engages. Multiplied by the signal's threshold. */
	elevatedMultiplier: number;
	/** Value at which `high` engages. Multiplied by the signal's threshold. */
	highMultiplier: number;
	/**
	 * Fraction by which the value must fall below a band's entry point before
	 * that band is released. 0.1 means "10% below". This is the whole point of
	 * the machine: without it a value hovering at the boundary emits a
	 * crossing on every poll.
	 */
	hysteresis: number;
};

export const DEFAULT_BAND_CONFIG: BandConfig = {
	elevatedMultiplier: 1,
	highMultiplier: 1.5,
	hysteresis: 0.1,
};

export function bandIndex(band: Band): number {
	return BANDS.indexOf(band);
}

/** The value at which `band` engages, or null for `normal`. */
export function enterThreshold(band: Band, threshold: number, config: BandConfig): number | null {
	switch (band) {
		case "normal":
			return null;
		case "elevated":
			return threshold * config.elevatedMultiplier;
		case "high":
			return threshold * config.highMultiplier;
	}
}

/** The value below which `band` is released, once hysteresis is applied. */
export function exitThreshold(band: Band, threshold: number, config: BandConfig): number | null {
	const entry = enterThreshold(band, threshold, config);
	if (entry === null) return null;
	return entry * (1 - config.hysteresis);
}

/** Highest band whose entry point the value meets. Ignores hysteresis. */
function rawBand(value: number, threshold: number, config: BandConfig): Band {
	if (value >= threshold * config.highMultiplier) return "high";
	if (value >= threshold * config.elevatedMultiplier) return "elevated";
	return "normal";
}

/**
 * Decide the next band from the current one.
 *
 * Escalation jumps straight to the band the sample justifies, so a machine
 * that goes from quiet to saturated is recognised at once rather than ramping
 * one band per poll.
 *
 * De-escalation moves one band at a time and only when the sample falls below
 * the current band's hysteretic exit point.
 *
 * A non-finite sample never changes the band. Missing or broken data must not
 * be read as "quiet" or "saturated"; the caller holds the previous band and
 * the hook adds nothing instead of announcing a crossing it cannot justify.
 */
export function nextBand(current: Band, value: number, threshold: number, config: BandConfig): Band {
	if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) return current;

	const target = rawBand(value, threshold, config);
	if (target === current) return current;

	const from = bandIndex(current);
	const to = bandIndex(target);

	if (to > from) return target;

	const exitAt = exitThreshold(current, threshold, config);
	if (exitAt !== null && value < exitAt) {
		return BANDS[from - 1];
	}
	return current;
}

/** True when a band change is a genuine crossing rather than a no-op. */
export function isCrossing(previous: Band, next: Band): boolean {
	return previous !== next;
}

/** Identifies which of the watched signals a band belongs to. */
export type Signal = "load" | "memory" | "swap" | "io";

export const SIGNALS: readonly Signal[] = ["load", "memory", "swap", "io"];
