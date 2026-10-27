/**
 * The hook against a real Claude Code binary.
 *
 * Set CLAUDE_BIN to a Claude Code executable to run this file. Without it
 * every test skips, so `npm test` stays hermetic.
 *
 * Keyless tests use an invalid API key. Claude Code runs `UserPromptSubmit`
 * hooks before it calls the API, so the stream still carries the hook's
 * response, and a malformed answer would show as a hook error. Model tests
 * need a real ANTHROPIC_API_KEY and run only when it is set: they check that
 * the model receives the message in the same run that produced it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE = process.env.CLAUDE_BIN;
const REAL_KEY = process.env.ANTHROPIC_API_KEY;
const skipAll = CLAUDE ? false : "CLAUDE_BIN is not set";
const skipModel = skipAll || (REAL_KEY ? false : "ANTHROPIC_API_KEY is not set");

type StreamEvent = {
	type: string;
	subtype?: string;
	hook_event?: string;
	output?: string;
	message?: { content?: Array<{ type: string; text?: string }> };
	result?: string;
};

async function session(prompt: string, events: string[], apiKey: string, extraArgs: string[] = []): Promise<StreamEvent[]> {
	const dir = await mkdtemp(join(tmpdir(), "claude-load-aware-real-"));
	const settings = join(dir, "settings.json");
	const hooks = Object.fromEntries(
		events.map((event) => [event, [{ hooks: [{ type: "command", command: `${process.execPath} ${join(ROOT, "hook.ts")}` }] }]]),
	);
	await writeFile(settings, JSON.stringify({ hooks }));

	const env = {
		PATH: process.env.PATH ?? "",
		HOME: dir,
		ANTHROPIC_API_KEY: apiKey,
		CLAUDE_LOAD_AWARE_CACHE_DIR: join(dir, "cache"),
		CLAUDE_LOAD_AWARE_CONFIG: join(dir, "absent.json"),
		// Any machine that has done work is above this threshold.
		CLAUDE_LOAD_AWARE_LOAD_THRESHOLD: "0.000001",
	};
	const args = ["-p", prompt, "--settings", settings, "--setting-sources", "", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--no-session-persistence", ...extraArgs];

	return new Promise((resolve, reject) => {
		const child = spawn(CLAUDE!, args, { env, cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.on("error", reject);
		child.on("close", () => {
			resolve(
				out
					.split("\n")
					.filter((line) => line.startsWith("{"))
					.map((line) => JSON.parse(line) as StreamEvent),
			);
		});
	});
}

function hookAnswer(events: StreamEvent[], hookEvent: string): { hookSpecificOutput: { hookEventName: string; additionalContext: string } } | undefined {
	const response = events.find((e) => e.subtype === "hook_response" && e.hook_event === hookEvent);
	const line = response?.output?.split("\n").find((l) => l.startsWith("{"));
	return line ? JSON.parse(line) : undefined;
}

test("Claude Code runs the UserPromptSubmit hook and accepts its answer", { skip: skipAll, timeout: 120_000 }, async () => {
	const events = await session("hi", ["UserPromptSubmit"], "sk-ant-api03-invalid");
	const answer = hookAnswer(events, "UserPromptSubmit");
	assert.ok(answer, "the stream carries a hook_response for UserPromptSubmit");
	assert.equal(answer.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.match(answer.hookSpecificOutput.additionalContext, /^System resource update\. Measurements only\./);
	assert.deepEqual(Object.keys(answer), ["hookSpecificOutput"]);
	const errors = events.filter((e) => e.subtype === "hook_response" && /invalid hook output|hook error/i.test(e.output ?? ""));
	assert.deepEqual(errors, []);
});

test("the model receives a PostToolUse message in the run that produced it", { skip: skipModel, timeout: 240_000 }, async () => {
	const prompt =
		'Run `echo step` with the Bash tool. Then quote, verbatim, the line that starts with "Load average" from any hook context you have seen, or write NONE.';
	const events = await session(prompt, ["PostToolUse"], REAL_KEY!, ["--allowedTools", "Bash"]);

	const answered = events.findIndex((e) => e.subtype === "hook_response" && e.hook_event === "PostToolUse");
	const toolUse = events.findIndex((e) => e.type === "assistant" && e.message?.content?.some((c) => c.type === "tool_use"));
	const finalText = events.findIndex((e) => e.type === "assistant" && e.message?.content?.some((c) => c.type === "text"));
	assert.ok(toolUse >= 0 && answered > toolUse, "the hook answered after the tool call");
	assert.ok(finalText > answered, "the final answer came after the hook answered");

	const result = events.find((e) => e.type === "result");
	assert.match(result?.result ?? "", /Load average: /, "the model quoted the hook's message");
	assert.equal(events.filter((e) => e.type === "result").length, 1, "one run, no continuation");
});

test("the model receives a UserPromptSubmit message and the hook never adds a turn", { skip: skipModel, timeout: 240_000 }, async () => {
	const events = await session(
		'Quote, verbatim, the line that starts with "Load average" from any hook context you have seen, or write NONE. Do not use tools.',
		["UserPromptSubmit", "PostToolUse"],
		REAL_KEY!,
	);
	const result = events.find((e) => e.type === "result");
	assert.match(result?.result ?? "", /Load average: /);
	const assistantTexts = events.filter((e) => e.type === "assistant" && e.message?.content?.some((c) => c.type === "text"));
	assert.equal(assistantTexts.length, 1, "exactly one assistant answer");
});
