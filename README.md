# claude-load-aware

Claude Code hooks that add machine load, memory use, swap use and disk I/O pressure to the current turn when any of them changes band.

The hook samples four numbers at two points and nowhere else: when a user prompt starts a turn (`UserPromptSubmit`) and after a tool call finishes while the turn is running (`PostToolUse`). The numbers are the 1-minute load average, the share of installed RAM in use, the share of swap in use, and the share of wall time the kernel records tasks waiting on disk I/O. When a value crosses a configured threshold, or falls back below it, the hook returns one message with the current figures as `hookSpecificOutput.additionalContext`. Claude Code adds that text to the model's context for the turn in progress.

The measures show pressure rather than activity. Memory follows each platform's own accounting of memory in use, not a naive total minus free. Disk I/O pressure is the kernel's PSI stall accounting (`/proc/pressure/io`), the share of wall time tasks spent waiting on I/O, in place of a throughput, `%util` or `iowait` figure that can move without anything waiting.

The hook samples all four signals together. A sample that crosses several thresholds produces one combined message, and a signal that did not cross appears in that message with its current band.

The hook runs only inside an event. Claude Code starts the hook as a new process for each event, and that process exits after answering. The next event leaves an already reported crossing out of its message.

## Exclusions

The hook reads and reports. It cannot change your work:

- It never starts a turn. It has no `Stop` hook and never emits `decision`, `continue`, `stopReason` or any other field that makes Claude Code take another step.
- It cannot block or edit a tool call, a prompt or a permission decision.
- It never writes to the system prompt and gives the model no instruction.
- It exits 0 on every path, including bad input and a failed sample, so a fault in the hook cannot interrupt a session.

Messages contain measurements. The test suite fails if a message contains imperative language aimed at the model.

## Example

```
System resource update. Measurements only.
Load average: 18.21 (1 min), 22.46 (5 min), 42.82 (15 min) on 16 logical CPUs. Band normal -> elevated.
Memory: 21.1 GiB of 31.3 GiB in use (68%), band normal.
Swap: 13.9 GiB of 16.0 GiB in use (87%). Band normal -> high.
I/O pressure: 10.2% of wall time with at least one task stalled on I/O, 1.3% of wall time with every task stalled on I/O, band normal.
```

## Hook events

The table covers Claude Code 2.1.308, the version this repository pins. "Current turn" means the model receives the text during the run the user started, before the final answer, and without a new user prompt. Each "observed" entry comes from a real `claude -p` session on the 2.1.308 binary. `scripts/probe-hooks.sh <event> <out-dir>` reproduces it: the script wires a probe hook to one event. The probe emits a unique token as `additionalContext`. In the session the prompt requires a tool call and then a quotation of the token. A control run without the hook returned `NONE`.

| Event | Adds context to the current turn? | Evidence |
| --- | --- | --- |
| `UserPromptSubmit` | Yes. This tool samples here. | Observed: the hook ran before the first model message, and the final answer quoted the token. Tests: `a crossing at a prompt answers UserPromptSubmit with additionalContext`, `hook.ts answers a crossing with the JSON Claude Code accepts, and persists the band`. |
| `PostToolUse` | Yes. This tool samples here. | Observed: the stream shows `hook_started` and `hook_response` for `PostToolUse` between the `tool_use` message and the next assistant message, and the answer quoted the token. A second run with only the real hook wired reported a crossing at `PostToolUse`, and the model quoted it. Test: `a crossing after a tool answers PostToolUse with additionalContext`. |
| `PostToolBatch` | Yes. This tool leaves it unwired. | Observed: the model received the token in the same run. The event runs once after a batch of parallel tool calls, so it samples less often than `PostToolUse`. |
| `PreToolUse` | Yes, in 2.1.308. This tool leaves it unwired. | Observed: the model received the token in the same run. The 2.1.308 schema lists `additionalContext` beside `permissionDecision` for this event. It runs before a tool executes, so a sample there describes the machine before the work the tool is about to do. Test: `every event except the two sampling ones is ignored without sampling`. |
| `Stop` | No. It continues the conversation. This tool leaves it unwired. | Observed: the model had already written a final answer (`NONE`). The `Stop` hook then ran, and a second assistant message followed that quoted the token. The binary's schema text agrees: "additionalContext is non-error feedback delivered to the model. The conversation continues so the model can act on it." That is a new step after the turn ended, which this tool must not cause. Test: `the example settings never register Stop or any other event`. |
| `SubagentStop` | No. It continues the subagent. This tool leaves it unwired. | Schema text in the binary: "the subagent continues so it can act on it." Not run in a session. |
| `SessionStart` | Yes, but before any turn. This tool leaves it unwired. | Observed: the model received the token. The event runs once when the session opens, so a sample there is stale by the first prompt, and `UserPromptSubmit` already samples at that moment. |
| `PostToolUseFailure`, `Notification`, `SubagentStart`, `Setup`, `UserPromptExpansion`, `PostModelSwitch` | The 2.1.308 schema accepts `additionalContext`. This tool leaves them unwired. | Schema only, not run in a session. A failed tool is not a tool that ran to completion, and the others are not sampling points. |
| `PermissionRequest`, `Elicitation`, `ElicitationResult`, `WorktreeCreate`, `CwdChanged`, `FileChanged`, `PreModelSwitch`, `MessageDisplay` | No. | The 2.1.308 schema gives these events their own output fields (decisions, paths, display text) and no `additionalContext`. Schema only. |
| `PreCompact`, `PostCompact`, `SessionEnd`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `InstructionsLoaded`, `WorktreeRemove`, `StopFailure` | No. | No `hookSpecificOutput.additionalContext` appears in the 2.1.308 schema for these events. Schema only. |

The schema entries come from the strings embedded in the 2.1.308 binary, so they describe what that version validates. Only the evidence marked "Observed" comes from a run against a model.

`PreToolUse` carries a context channel in 2.1.308, so it can inject text as well as decide. This tool ignores it because its sampling points are fixed at the prompt and after a tool.

## Install

Node 22.18 or later runs `hook.ts` directly, because it strips TypeScript types without a build step. Clone the repository, then add the two hooks to a Claude Code settings file such as `~/.claude/settings.json`, and replace the path with the clone's location:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/claude-load-aware/hook.ts"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/claude-load-aware/hook.ts"
          }
        ]
      }
    ]
  }
}
```

`examples/settings.json` repeats the snippet, and a test checks that the two match. Leave every other event unwired. `package.json` sets `private`, which stops an accidental npm publish.

## Bands

Each signal has three bands: `normal`, `elevated` and `high`. The thresholds are the signal's own threshold multiplied by 1.0 and 1.5, and each band releases at 10% below its entry point. That margin stops a value hovering at a boundary from producing a message at every sample.

An upward crossing moves straight to the band the sample justifies. Recovery is slower. A downward crossing steps down one band at a time, so a recovering machine reports `high`, then `elevated`, then `normal`, one message per step.

If a sensor stops answering, its band holds. Treating missing data as quiet would manufacture a recovery out of a dead reader. The hook writes one line to stderr the first time a sensor is unavailable in a session. That line goes to the hook log and never to the model.

## State between invocations

Each hook event is a separate process, so the bands persist in a file per session. The file name is the SHA-256 of the session id from the hook input. The cache directory contains it, and it stores the four bands plus a flag per sensor. The hook writes it to a temporary file and renames it over the target, so a reader never sees a partial write. A missing, unreadable or malformed file starts every band at `normal`.

Parallel tool calls can fire several `PostToolUse` hooks at once. A lock file per session makes them take turns, so one crossing produces one message. A hook that cannot get the lock within two seconds adds nothing for that event. The first write of a new session removes state files older than seven days and keeps at most 200 files, oldest removed first.

Sessions do not see each other. Several sessions on one machine each report their own crossings.

## Configuration

Settings resolve in the order defaults, then config file, then environment. The config file is optional.

| Setting | Environment variable | File key | Default |
| --- | --- | --- | --- |
| Load threshold, in load-average units | `CLAUDE_LOAD_AWARE_LOAD_THRESHOLD` | `loadThreshold` | Number of logical CPUs |
| Memory threshold, as a percent of RAM | `CLAUDE_LOAD_AWARE_MEMORY_THRESHOLD` | `memoryThresholdPercent` | `80` |
| Swap threshold, as a percent of swap | `CLAUDE_LOAD_AWARE_SWAP_THRESHOLD` | `swapThresholdPercent` | `50` |
| I/O pressure threshold, as a percent of wall time | `CLAUDE_LOAD_AWARE_IO_THRESHOLD` | `ioPressureThresholdPercent` | `20` |
| Hysteresis as a fraction | `CLAUDE_LOAD_AWARE_HYSTERESIS` | `hysteresis` | `0.1` |
| Master switch | `CLAUDE_LOAD_AWARE_ENABLED` | `enabled` | `true` |
| Cache directory for session state | `CLAUDE_LOAD_AWARE_CACHE_DIR` | `cacheDir` | `$XDG_CACHE_HOME/claude-load-aware`, else `~/.cache/claude-load-aware` |
| Config file path | `CLAUDE_LOAD_AWARE_CONFIG` | none | `~/.config/claude-load-aware/config.json` |
| Debug logging to stderr | `CLAUDE_LOAD_AWARE_DEBUG=1` | none | unset |

A load threshold equal to the CPU count means the machine has as many runnable threads as it has cores. A memory threshold of 80 means 80% of installed RAM is in use. A swap threshold of 50 means half of the configured swap is committed. An I/O threshold of 20 means tasks waited on I/O for 20% of wall time. A value outside its valid range produces a stderr warning and the default stays.

With `enabled` set to `false`, the hook exits before sampling and returns no context.

## Limitations

- Each Claude Code session monitors itself, and the hook has no view of other sessions or of other machines.
- Memory figures follow each platform's own accounting of memory in use, because `os.freemem()` counts reclaimable page cache as in use and reports near-saturation on a machine with a warm cache. On macOS the reader parses `vm_stat` and adds anonymous, wired and compressed pages, which is the total Activity Monitor shows. On Linux it reads `/proc/meminfo` and subtracts `MemAvailable` from `MemTotal`. Everywhere else, and whenever either source fails, it falls back to `os.totalmem() - os.freemem()`.
- Swap follows the platform too: `/proc/meminfo` on Linux and `sysctl vm.swapusage` on macOS. A machine with no swap reports `none configured` rather than a percentage of nothing.
- Swap usage is a fill level and does not fall on its own. A machine that filled its swap once stays in its band while the pages stay there, whether or not it is paging now. The I/O pressure line is the moving figure beside it.
- I/O pressure comes from PSI, which is Linux-only. On macOS and Windows the hook reports it as unavailable once per session rather than substituting `%util` or `iowait`. A Linux kernel built without PSI has no `/proc/pressure/io` and reports the same way.
- Load average counts runnable and uninterruptible threads, so heavy disk I/O raises it even when the CPUs are idle. On Windows `os.loadavg()` returns zeros, so the reader reports load as unavailable.
- A value oscillating across a band boundary produces one message per crossing. Raise `hysteresis` to reduce the rate.
- A sample at `PostToolUse` costs one process start plus the sensor reads. On macOS the memory, swap and load readers can each start a short child process.
- The hook sees only turns that run tools to completion. A turn with no tool call gets a sample at its prompt and none after.
- Claude Code decides what happens to `additionalContext` in later versions. This repository pins 2.1.308 for every behavioural claim above.

## Development

```
npm install
npm run check   # tsc --noEmit
npm test        # node --test
```

The suite covers the band arithmetic, the load, memory, swap and I/O readers, configuration precedence, the state file (persistence, corruption, session isolation, pruning, locking), and the hook handler driven with injected samplers, so nothing depends on the host machine. `test/wiring.test.ts` spawns `hook.ts` as Claude Code does and checks the JSON it prints. It also confirms the example settings wire exactly two events.

`src/signals.ts` holds the band machine and imports nothing from Claude Code. It takes a value, a threshold and the current band, and returns the next band. Every signal shares it.

## License

MIT. See [LICENSE](LICENSE).
