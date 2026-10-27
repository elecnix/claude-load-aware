/**
 * Presentation helpers shared by the signal readers.
 *
 * Kept apart from `memory.ts` because more than one reader reports a byte
 * count now: memory reports RAM and swap reports disk-backed pages, and both
 * want the same binary units.
 */

const BYTES_PER_GIB = 1024 ** 3;

/** Human-readable byte count, binary units. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
	if (bytes >= BYTES_PER_GIB) return `${(bytes / BYTES_PER_GIB).toFixed(1)} GiB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
	return `${bytes} B`;
}
