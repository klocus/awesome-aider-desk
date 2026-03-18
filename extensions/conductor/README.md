# Conductor Workflow Extension

A multi-agent orchestration framework for AiderDesk. The **Conductor** agent plans work, creates a `SPEC.md` as the source of truth, and delegates implementation to specialist subagents. Each subagent has a focused role and runs in its own context.

## Features

- **8 agents** — Conductor + 7 specialists *(Investigator, Implementor, Verifier, Critic, Debugger, Code Reviewer, Simplifier)*
- **`update-spec` / `read-spec` tools** — write and read `SPEC.md` stored inside the AiderDesk's task directory
- **`delegate-to-agent` tool** — orchestrates work using one of two modes:
  - `subtask` mode: Creates a visible child task, runs subagent there, and pulls results back.
  - `subagent` mode: Uses subagent system in the current task context.
- **Config-driven** — central `config.json` for delegation mode and global defaults; individual agent overrides and instructions in `agents/index.json` + `.md` files.

## Agents

- **Investigator** — Explore codebase, assess feasibility
- **Implementor** — Execute implementation plans
- **Verifier** — Check implementations match specs
- **Critic** — Review specs for feasibility
- **Debugger** — Analyze and fix issues
- **Code Reviewer** — Automated reviews with severity
- **Simplifier** — Simplifies code for clarity, consistency, and maintainability

## Installation

**Global** (available in all projects)

```bash
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/conductor --global
```

**Local** (project-level)

```bash
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/conductor
```

## How to use it

1. Select the **Conductor** agent profile in a task.
2. Describe what you want. The Conductor will ask clarifying questions, write a SPEC, and wait for your approval before doing anything.
3. Approve the plan. The Conductor creates subtasks and delegates waves of work to specialists.
4. After each wave the Conductor runs Verifier and Code Reviewer automatically, iterates on failures, and summarizes results.

Individual agent instructions are in the `agents/` directory — edit the `.md` files to adjust behavior.

## Configuration

Set your global defaults and delegation mode in `config.json`:

```json
{
  "delegationMode": "subtask",
  "defaults": {
    "provider": "anthropic",
    "model": "claude-4-5-sonnet-latest",
    "maxIterations": 100,
    "autoApprove": true,
    ...
  }
}
```

- **`delegationMode`**: Choose `"subtask"` (creates child tasks) or `"subagent"` (uses AiderDesk's native system in current task).
- **`defaults`**: Global settings for all agents.

Individual agents can still override these in `agents/index.json` using the `overrides` block. Any provider configured in AiderDesk works here.

Individual agent instructions are in the `agents/` directory — edit the `.md` files to adjust specific behavior.
