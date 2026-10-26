/**
 * claude-load-aware hook command.
 *
 * Claude Code runs this once per hook event. It reads the event's JSON from
 * stdin and, when a band changed, writes one JSON answer to stdout. It exits
 * 0 in every case: a hook failure must never block or interrupt a session.
 * There is no daemon and no timer, and nothing runs between events.
 */

import { handleHook } from "./src/hook.ts";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	let input: unknown;
	try {
		input = JSON.parse(await readStdin());
	} catch {
		return;
	}
	const output = await handleHook(input);
	if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(`[claude-load-aware] ${(error as Error).message}`);
		process.exit(0);
	},
);
