// Evidence probe, not part of the shipped hook. Claude Code runs this as a
// hook command. It logs the event it was called for and answers with an
// additionalContext string that carries a nonce, so a real session can show
// whether that string reached the model and when.
import { appendFileSync, readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const event = input.hook_event_name;
const log = process.env.PROBE_LOG;
if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), event, tool: input.tool_name, stop_hook_active: input.stop_hook_active, keys: Object.keys(input).sort(), session_id_is_string: typeof input.session_id === "string" }) + "\n");

// A Stop hook that always answers would loop; answer the first call only.
if (event === "Stop" && input.stop_hook_active) process.exit(0);

const nonce = process.env.PROBE_NONCE ?? "nonce-unset";
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: `Probe record for ${event}: the token is ${nonce}.` },
  }) + "\n",
);
