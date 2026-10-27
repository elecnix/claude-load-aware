#!/bin/sh
# Runs one real `claude -p` session per hook event against the pinned binary,
# with a scratch settings file that wires only the probe hook to that event.
# Usage: scripts/probe-hooks.sh <event> <out-dir>
set -eu
EVENT="$1"
OUT="$2"
CLAUDE="${CLAUDE_BIN:-/tmp/cc-2.1.308/bin/claude}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
NONCE="zebra-$(date +%s)-$EVENT"
export PROBE_NONCE="$NONCE" PROBE_LOG="$OUT/$EVENT.hook.log"
: > "$PROBE_LOG"
cat > "$OUT/$EVENT.settings.json" <<JSON
{"hooks":{"$EVENT":[{"hooks":[{"type":"command","command":"node $HERE/probe-hook.mjs"}]}]}}
JSON
PROMPT='Run the shell command `echo probe-step` with the Bash tool. Then answer in one line: copy the exact token from any "Probe record" text you have seen in this conversation, or write NONE if you saw none.'
cd "$OUT"
"$CLAUDE" -p "$PROMPT" --settings "$OUT/$EVENT.settings.json" --setting-sources "" \
  --allowedTools Bash --output-format stream-json --verbose --include-hook-events --no-session-persistence \
  < /dev/null > "$OUT/$EVENT.stream.jsonl" 2> "$OUT/$EVENT.stderr" || true
echo "nonce=$NONCE"
