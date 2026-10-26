/**
 * Band state that persists between hook invocations.
 *
 * Claude Code starts a new process for every hook event, so the band machine
 * cannot keep its bands in memory the way a long-lived extension does. Each
 * session gets one small JSON file under the cache directory, named by the
 * SHA-256 of the session id so a hostile id cannot name a path.
 *
 * Reads never fail: a missing, unreadable or malformed file yields the
 * starting state with every band at `normal`. Writes go to a temporary file in
 * the same directory and are renamed over the target, so a reader sees the old
 * file or the new one and never a partial write.
 *
 * Two hooks for one session can run at the same moment, because Claude Code
 * may run parallel tool calls. `withSessionLock` serializes the read, sample
 * and write steps per session, so one crossing is reported once.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { BANDS, SIGNALS, type Band, type Signal } from "./signals.ts";

const STATE_VERSION = 1;

export type SessionState = {
	version: typeof STATE_VERSION;
	bands: Record<Signal, Band>;
	/** One-shot guards so a broken sensor is reported once per session, not per event. */
	unavailableNotified: Record<Signal, boolean>;
	updatedAt: number;
};

function perSignal<T>(value: T): Record<Signal, T> {
	return { load: value, memory: value, swap: value, io: value };
}

export function freshState(now: number): SessionState {
	return { version: STATE_VERSION, bands: perSignal<Band>("normal"), unavailableNotified: perSignal(false), updatedAt: now };
}

export function statePath(dir: string, sessionId: string): string {
	return `${dir}/${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

function isBand(value: unknown): value is Band {
	return typeof value === "string" && (BANDS as readonly string[]).includes(value);
}

/** Parse a stored state, or null when the contents are not a state this version wrote. */
function parseState(raw: string, now: number): SessionState | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (record.version !== STATE_VERSION) return null;
	const bands = record.bands as Record<string, unknown> | null;
	if (!bands || typeof bands !== "object") return null;

	const state = freshState(typeof record.updatedAt === "number" ? record.updatedAt : now);
	for (const signal of SIGNALS) {
		if (!isBand(bands[signal])) return null;
		state.bands[signal] = bands[signal];
	}
	const notified = record.unavailableNotified as Record<string, unknown> | null | undefined;
	if (notified && typeof notified === "object") {
		for (const signal of SIGNALS) state.unavailableNotified[signal] = notified[signal] === true;
	}
	return state;
}

export async function readState(dir: string, sessionId: string, now: number): Promise<SessionState> {
	try {
		return parseState(await readFile(statePath(dir, sessionId), "utf8"), now) ?? freshState(now);
	} catch {
		return freshState(now);
	}
}

export async function writeState(dir: string, sessionId: string, state: SessionState): Promise<void> {
	await mkdir(dir, { recursive: true });
	const target = statePath(dir, sessionId);
	const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
		await rename(temporary, target);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}

export type PruneLimits = {
	/** State files untouched for longer than this are removed. */
	maxAgeMs: number;
	/** At most this many state files remain, oldest removed first. */
	maxFiles: number;
};

export const DEFAULT_PRUNE_LIMITS: PruneLimits = { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxFiles: 200 };

/**
 * Remove state files that are too old or beyond the count limit. Returns how
 * many were removed. A missing directory is not an error, and neither is a
 * file another process removed first.
 */
export async function pruneState(dir: string, now: number, limits: PruneLimits = DEFAULT_PRUNE_LIMITS): Promise<number> {
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
	} catch {
		return 0;
	}

	const entries: Array<{ path: string; mtimeMs: number }> = [];
	for (const name of names) {
		const path = `${dir}/${name}`;
		try {
			entries.push({ path, mtimeMs: (await stat(path)).mtimeMs });
		} catch {
			// removed by another process between readdir and stat
		}
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

	let removed = 0;
	for (const [index, entry] of entries.entries()) {
		if (index >= limits.maxFiles || now - entry.mtimeMs > limits.maxAgeMs) {
			if (await unlink(entry.path).then(() => true, () => false)) removed++;
		}
	}
	return removed;
}

export type LockOptions = {
	/** How long to wait for a held lock before giving up. */
	timeoutMs?: number;
	/** A lock file older than this belongs to a process that died. */
	staleMs?: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding the session's lock file. Returns undefined, without
 * running `fn`, when the lock stays held past the timeout: the caller then
 * adds nothing for this event rather than racing another invocation.
 */
export async function withSessionLock<T>(
	dir: string,
	sessionId: string,
	fn: () => Promise<T>,
	options: LockOptions = {},
): Promise<T | undefined> {
	const timeoutMs = options.timeoutMs ?? 2000;
	const staleMs = options.staleMs ?? 10_000;
	const lock = `${statePath(dir, sessionId)}.lock`;
	await mkdir(dir, { recursive: true });

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const handle = await open(lock, "wx");
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
		}
		const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
		if (age > staleMs) {
			await unlink(lock).catch(() => {});
			continue;
		}
		if (Date.now() >= deadline) return undefined;
		await sleep(10);
	}

	try {
		return await fn();
	} finally {
		await unlink(lock).catch(() => {});
	}
}
