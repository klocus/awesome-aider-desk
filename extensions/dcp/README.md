# Dynamic Context Pruning (DCP) Extension for AiderDesk

An extension that automatically manages conversation context to reduce token usage during long agent sessions. Inspired by [OpenCode's DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) mechanism.

## Features

- **Deduplication** — removes earlier results of identical tool calls (same tool, same input), keeping only the latest.
- **Supersede Writes** — prunes earlier `file_write` / `file_edit` results when the same file is subsequently read, since the read already contains the latest content.
- **Purge Error Inputs** — strips large string inputs from assistant tool calls that errored, once they're N+ user turns in the past.
- **Manual Prune Tool** (`dcp-prune`) — AI can mark specific tool messages for pruning on the next request.
- **Distill Tool** (`dcp-distill`) — AI can summarize findings from a range of messages and prune all tool outputs in that range, retaining the summary.
- **Protected Tools** — AiderDesk-native tools that manage state (tasks, todos, memory, skills, subagents, Aider context files, code generation) are never pruned.
- **Context Nudge** — periodic notifications when context grows large, reminding the agent to clean up.
- **Configurable Behavior** — extensive configuration via `config.json` for fine-tuning strategies and tool availability.

## Installation

**From this repository** (recommended)

**Global** (available in all projects)

```bash
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/dcp --global
```

**Local** (project-level)

```bash
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/dcp
```

## Impact on Prompt Caching

LLM providers like Anthropic and OpenAI cache prompts based on exact prefix matching. When DCP prunes a tool output, it changes the message content, which invalidates cached prefixes from that point forward.

**Trade-off:** You lose some cache read benefits but gain larger token savings from reduced context size and performance improvements through reduced context poisoning. In most cases, token savings outweigh the cache miss cost—especially in long sessions where context bloat becomes significant.

## Configuration

DCP reads its configuration from `dcp/config.json`. All settings are optional and have sensible defaults.

```json
{
  "enabled": true,
  "manualMode": false,
  "protectedTools": [],
  "tools": {
    "nudgeEnabled": true,
    "nudgeFrequency": 10,
    "distill": true,
    "prune": true
  },
  "strategies": {
    "deduplication": { "enabled": true },
    "supersedeWrites": { "enabled": true },
    "purgeErrors": { "enabled": true, "turns": 4 }
  }
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the entire extension. |
| `manualMode` | boolean | `false` | If `true`, disables automatic pruning and prunable-tools injection. Agent must manually call `dcp-prune` or `dcp-distill`. |
| `protectedTools` | string[] | `[]` | Additional tool name patterns to never prune. Uses substring matching. |

### Tools Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tools.nudgeEnabled` | boolean | `true` | Enable periodic nudges to manage context. |
| `tools.nudgeFrequency` | number | `10` | How many turns between nudge notifications. |
| `tools.distill` | boolean | `true` | Enable the `dcp-distill` tool for the agent. |
| `tools.prune` | boolean | `true` | Enable the `dcp-prune` tool for the agent. |

### Strategy Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `strategies.deduplication.enabled` | boolean | `true` | Enable automatic deduplication of identical tool calls. |
| `strategies.supersedeWrites.enabled` | boolean | `true` | Enable pruning of superseded write operations. |
| `strategies.purgeErrors.enabled` | boolean | `true` | Enable stripping large inputs from failed tool calls. |
| `strategies.purgeErrors.turns` | number | `4` | Minimum user turns before error input purging applies. |

### Protected Tool Patterns (Hardcoded)

The following tool patterns are **never** pruned regardless of configuration:
- DCP's own tools: `dcp-prune`, `dcp-distill`
- AiderDesk task management: `tasks---`, `todo---`, `skills---`, `memory---`, `subagents---`
- Aider context files: `get_context_files`, `add_context_files`, `drop_context_files`
- Aider code generation: `run_prompt`

> **Note:** Shell execution tools like `bash` are **not** in the protected list and can be pruned. However, they are excluded from deduplication (Phase 3) to prevent removing side-effect operations.

## How It Works

Every time AiderDesk is about to send a request to the LLM, DCP runs a pruning pass over the conversation history in 6 sequential phases:

**Phase 0 — Build tool call index**
Scans all assistant messages and builds a lookup from `toolCallId` to the tool's name and input parameters. Used by subsequent phases to identify tools and their arguments.

**Phase 1 — Apply distillation ranges**
If `dcp-distill` was previously called, replaces all tool outputs within the specified message range with a single placeholder containing the AI-provided summary.

**Phase 2 — Apply manual prunes**
Replaces outputs of any tool messages explicitly marked via `dcp-prune` with a pruned placeholder.

**Phase 3 — Deduplication**
Scans tool results and builds a signature from `(toolName, inputParams)`. If the same tool was called with identical parameters more than once, all occurrences except the latest are pruned. Write tools and protected tools are excluded from this phase.

**Phase 4 — Supersede writes**
Tracks `file_write` / `file_edit` calls per file path. If a subsequent `file_read`, `grep`, `glob`, or similar read tool is called on the same path, the earlier write result is pruned — the read already contains the current state of the file.

**Phase 5 — Purge error inputs**
Finds tool calls that returned errors and are N+ user turns old. Replaces large string inputs (`> 100 chars`) in the corresponding assistant messages with a placeholder, since the failed call's context is unlikely to be relevant.

**Phase 6 — Inject prunable-tools context** (skip in manual mode)
Builds and injects a `<prunable-tools>` list into the last user message, showing the agent which tool messages are available for manual pruning or distillation. Also includes:
- A `<distill-range>` hint with the full available range
- Periodic nudge notifications when context grows large
- A cooldown message after any DCP tool was just used

## Commands

| Command              | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| `/dcp stats`         | Show total pruning statistics (parts pruned, tokens saved, active ranges). |
| `/dcp sweep [count]` | Mark all (or last N) tool messages for pruning on the next request.        |
| `/dcp reset`         | Clear all DCP state — stats, prune marks, and distillation ranges.         |

## Tools Available to the Agent

| Tool          | Description                                                             |
| ------------- | ----------------------------------------------------------------------- |
| `dcp-prune`   | Mark specific tool messages by ID for pruning.                          |
| `dcp-distill` | Summarize a range of messages and prune all tool outputs in that range. |

The agent is instructed to use these proactively when the context grows large or after completing a research/exploration phase. In **manual mode**, these are the ONLY way to prune context.

## Usage

DCP works automatically in the background. No configuration is required.

The agent has access to `dcp-prune` and `dcp-distill` tools and is instructed to use them proactively. You can also trigger context cleanup manually using the `/dcp sweep` command.

To customize behavior, edit `dcp/config.json` after installation. Changes take effect on the next agent session.
