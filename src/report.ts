/**
 * The message text.
 *
 * Every sentence is a measurement or a statement about which band changed.
 * There is no imperative anywhere in this module: the reader gets the numbers
 * and draws their own conclusion.
 */

import { formatBytes } from "./format.ts";
import type { LoadSample } from "./load.ts";
import type { MemorySample } from "./memory.ts";
import type { SwapSample } from "./swap.ts";
import type { IoPressureSample } from "./io.ts";
import type { Band, Signal } from "./signals.ts";

export type Change = { signal: Signal; previous: Band; next: Band };

export type Snapshot = {
	load: LoadSample;
	memory: MemorySample;
	swap: SwapSample;
	io: IoPressureSample;
	bands: Record<Signal, Band>;
	cpus: number;
};

/** The band half of a signal's sentence: a crossing names both bands, an
 *  unchanged signal names the one it is in. The caller's sentence carries no
 *  final punctuation so this can supply it. */
function bandClause(change: Change | undefined, current: Band): string {
	return change ? `. Band ${change.previous} -> ${change.next}.` : `, band ${current}.`;
}

/** Swap line body. A machine with no swap has a reading, not a percentage. */
function swapSentence(sample: SwapSample): string {
	if (sample.totalBytes === 0) return "Swap: none configured";
	return (
		`Swap: ${formatBytes(sample.usedBytes)} of ${formatBytes(sample.totalBytes)} in use ` +
		`(${(sample.usedFraction * 100).toFixed(0)}%)`
	);
}

/** I/O line body. The `full` share appears only when the kernel reported it. */
function ioSentence(sample: IoPressureSample): string {
	const some = (sample.some10 * 100).toFixed(1);
	const full =
		sample.full10 === null
			? ""
			: `, ${(sample.full10 * 100).toFixed(1)}% of wall time with every task stalled on I/O`;
	return `I/O pressure: ${some}% of wall time with at least one task stalled on I/O${full}`;
}

/**
 * Compose the one combined message for a sample. Every signal with a reading
 * gets a line, whether or not it changed, so one message carries the full
 * picture. A signal without a reading gets no line at all.
 */
export function formatCombinedReport(changes: Change[], snapshot: Snapshot): string {
	const changed = new Map<Signal, Change>();
	for (const change of changes) changed.set(change.signal, change);

	const lines: string[] = ["System resource update. Measurements only."];

	const { load, memory, swap, io, bands, cpus } = snapshot;
	if (load.available) {
		lines.push(
			`Load average: ${load.load1.toFixed(2)} (1 min), ${load.load5.toFixed(2)} (5 min), ` +
				`${load.load15.toFixed(2)} (15 min) on ${cpus} logical CPUs` +
				bandClause(changed.get("load"), bands.load),
		);
	}
	if (memory.available) {
		lines.push(
			`Memory: ${formatBytes(memory.usedBytes)} of ${formatBytes(memory.totalBytes)} in use ` +
				`(${(memory.usedFraction * 100).toFixed(0)}%)` +
				bandClause(changed.get("memory"), bands.memory),
		);
	}
	if (swap.available) lines.push(swapSentence(swap) + bandClause(changed.get("swap"), bands.swap));
	if (io.available) lines.push(ioSentence(io) + bandClause(changed.get("io"), bands.io));

	return lines.join("\n");
}
