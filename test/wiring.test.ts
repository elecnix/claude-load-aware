/**
 * What the shipped configuration registers, and the process contract of
 * `hook.ts`: JSON on stdin, JSON on stdout, one invocation per event.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Registration = { hooks: Array<{ type: string; command: string }> };
type Settings = { hooks: Record<string, Registration[]> };

async function shippedSettings(): Promise<Settings> {
	return JSON.parse(await readFile(join(ROOT, "examples", "settings.json"), "utf8")) as Settings;
}

test("the example settings register exactly UserPromptSubmit and PostToolUse", async () => {
	const settings = await shippedSettings();
	assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "UserPromptSubmit"]);
	for (const registrations of Object.values(settings.hooks)) {
		for (const registration of registrations) {
			for (const hook of registration.hooks) {
				assert.equal(hook.type, "command");
				assert.match(hook.command, /hook\.ts$/);
			}
		}
	}
});

test("the example settings never register Stop or any other event", async () => {
	const settings = await shippedSettings();
	for (const event of ["Stop", "SubagentStop", "PreToolUse", "PostToolUseFailure", "PostToolBatch", "SessionStart", "Notification"]) {
		assert.equal(event in settings.hooks, false, event);
	}
});

test("the README shows the same settings the example file holds", async () => {
	const readme = await readFile(join(ROOT, "README.md"), "utf8");
	const example = JSON.stringify(await shippedSettings(), null, 2);
	assert.ok(readme.includes(example), "README install snippet differs from examples/settings.json");
});

function runHook(stdin: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(ROOT, "hook.ts")], { env: { PATH: process.env.PATH ?? "", ...env } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code }));
		child.stdin.end(stdin);
	});
}

test("hook.ts answers a crossing with the JSON Claude Code accepts, and persists the band", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "claude-load-aware-e2e-"));
	// A threshold this low engages the load band on any machine that has done any work.
	const env = {
		CLAUDE_LOAD_AWARE_CACHE_DIR: cacheDir,
		CLAUDE_LOAD_AWARE_CONFIG: join(cacheDir, "absent.json"),
		CLAUDE_LOAD_AWARE_LOAD_THRESHOLD: "0.000001",
		HOME: cacheDir,
	};
	const event = JSON.stringify({ session_id: "e2e-session", hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: "/tmp", transcript_path: "/tmp/t.jsonl" });

	const first = await runHook(event, env);
	assert.equal(first.code, 0);
	const parsed = JSON.parse(first.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
	assert.deepEqual(Object.keys(parsed), ["hookSpecificOutput"]);
	assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string");
	assert.match(parsed.hookSpecificOutput.additionalContext, /Load average:/);

	const second = await runHook(event.replace("UserPromptSubmit", "PostToolUse"), env);
	assert.equal(second.code, 0);
	assert.equal(second.stdout, "", "a second process finds the stored band and has nothing new to report");
});

test("hook.ts exits 0 with no output for garbage on stdin and for an unwired event", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "claude-load-aware-e2e-"));
	const env = { CLAUDE_LOAD_AWARE_CACHE_DIR: cacheDir, HOME: cacheDir };
	for (const stdin of ["", "not json", "[]", JSON.stringify({ session_id: "s", hook_event_name: "Stop", stop_hook_active: false })]) {
		const result = await runHook(stdin, env);
		assert.equal(result.code, 0, stdin);
		assert.equal(result.stdout, "", stdin);
	}
});
