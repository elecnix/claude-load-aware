/**
 * Band state that survives between hook processes.
 *
 * Each hook event is a separate process, so everything the band machine needs
 * to remember sits in a per-session file. These tests use a throwaway cache
 * directory and a fixed clock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshState, readState, writeState, pruneState, statePath, withSessionLock } from "../src/state.ts";

const DAY = 24 * 60 * 60 * 1000;

async function scratch(): Promise<string> {
	return mkdtemp(join(tmpdir(), "claude-load-aware-state-"));
}

test("a missing file starts every band at normal", async () => {
	const dir = await scratch();
	const state = await readState(dir, "session-a", 1000);
	assert.deepEqual(state.bands, { load: "normal", memory: "normal", swap: "normal", io: "normal" });
});

test("written state reads back unchanged", async () => {
	const dir = await scratch();
	const state = freshState(1000);
	state.bands.load = "high";
	state.bands.io = "elevated";
	state.unavailableNotified.swap = true;
	await writeState(dir, "session-a", state);
	const back = await readState(dir, "session-a", 2000);
	assert.deepEqual(back.bands, state.bands);
	assert.equal(back.unavailableNotified.swap, true);
});

test("a corrupt file starts from normal instead of failing", async () => {
	const dir = await scratch();
	await writeState(dir, "session-a", freshState(1000));
	await writeFile(statePath(dir, "session-a"), "{not json");
	const state = await readState(dir, "session-a", 2000);
	assert.deepEqual(state.bands, { load: "normal", memory: "normal", swap: "normal", io: "normal" });
});

test("a file with an unknown band or a wrong shape is treated as corrupt", async () => {
	const dir = await scratch();
	for (const body of [
		JSON.stringify({ version: 1, bands: { load: "critical", memory: "normal", swap: "normal", io: "normal" } }),
		JSON.stringify(["elevated"]),
		JSON.stringify({ version: 99, bands: {} }),
		"null",
	]) {
		await writeFile(statePath(dir, "session-a"), body);
		const state = await readState(dir, "session-a", 2000);
		assert.deepEqual(state.bands, { load: "normal", memory: "normal", swap: "normal", io: "normal" }, body);
	}
});

test("two sessions keep separate state", async () => {
	const dir = await scratch();
	const a = freshState(1000);
	a.bands.memory = "high";
	await writeState(dir, "session-a", a);
	assert.equal((await readState(dir, "session-a", 2000)).bands.memory, "high");
	assert.equal((await readState(dir, "session-b", 2000)).bands.memory, "normal");
});

test("a session id cannot escape the cache directory", async () => {
	const dir = await scratch();
	const hostile = "../../outside/../evil";
	assert.ok(statePath(dir, hostile).startsWith(dir + "/"));
	await writeState(dir, hostile, freshState(1000));
	const names = await readdir(dir);
	assert.equal(names.length, 1);
	assert.match(names[0], /^[0-9a-f]{64}\.json$/);
});

test("a write leaves no temporary file behind", async () => {
	const dir = await scratch();
	await writeState(dir, "session-a", freshState(1000));
	await writeState(dir, "session-a", freshState(2000));
	const names = await readdir(dir);
	assert.deepEqual(names, [`${names[0]}`]);
	assert.ok(names[0].endsWith(".json"));
});

test("pruning removes files older than the age limit and keeps recent ones", async () => {
	const dir = await scratch();
	await writeState(dir, "old", freshState(0));
	await writeState(dir, "recent", freshState(0));
	const now = Date.now();
	await utimes(statePath(dir, "old"), new Date(now - 10 * DAY), new Date(now - 10 * DAY));
	const removed = await pruneState(dir, now, { maxAgeMs: 7 * DAY, maxFiles: 100 });
	assert.equal(removed, 1);
	assert.deepEqual(await readdir(dir), [`${statePath(dir, "recent").split("/").pop()}`]);
});

test("pruning caps the number of files and removes the oldest first", async () => {
	const dir = await scratch();
	const now = Date.now();
	for (let i = 0; i < 5; i++) {
		await writeState(dir, `s${i}`, freshState(0));
		const when = new Date(now - (5 - i) * 1000);
		await utimes(statePath(dir, `s${i}`), when, when);
	}
	await pruneState(dir, now, { maxAgeMs: 7 * DAY, maxFiles: 2 });
	const left = await readdir(dir);
	assert.equal(left.length, 2);
	assert.ok(left.includes(statePath(dir, "s4").split("/").pop()!));
	assert.ok(left.includes(statePath(dir, "s3").split("/").pop()!));
});

test("pruning a missing directory is not an error", async () => {
	assert.equal(await pruneState("/nonexistent/claude-load-aware-cache", Date.now(), { maxAgeMs: DAY, maxFiles: 10 }), 0);
});

test("the session lock runs one holder at a time", async () => {
	const dir = await scratch();
	const order: string[] = [];
	const run = (label: string) =>
		withSessionLock(dir, "session-a", async () => {
			order.push(`${label}:start`);
			await new Promise((resolve) => setTimeout(resolve, 30));
			order.push(`${label}:end`);
		});
	await Promise.all([run("a"), run("b")]);
	assert.equal(order.length, 4);
	assert.equal(order[0].split(":")[0], order[1].split(":")[0], "the first holder finishes before the second starts");
});

test("a stale lock left by a dead process is taken over", async () => {
	const dir = await scratch();
	const lock = `${statePath(dir, "session-a")}.lock`;
	await writeFile(lock, "");
	const old = new Date(Date.now() - 60_000);
	await utimes(lock, old, old);
	const result = await withSessionLock(dir, "session-a", async () => "ran");
	assert.equal(result, "ran");
});

test("a lock that stays held makes the caller give up with no result", async () => {
	const dir = await scratch();
	const lock = `${statePath(dir, "session-a")}.lock`;
	await writeFile(lock, "");
	const result = await withSessionLock(dir, "session-a", async () => "ran", { timeoutMs: 100, staleMs: 60_000 });
	assert.equal(result, undefined);
	assert.ok((await stat(lock)).isFile(), "a live holder's lock is left alone");
	assert.equal((await readFile(lock, "utf8")).length, 0);
});
