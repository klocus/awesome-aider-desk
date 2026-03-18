# Task Flow Extension for AiderDesk

Task Flow is an advanced project orchestration and **cross-task memory** system for AiderDesk. It transforms simple, flat task lists into dynamic execution pipelines with dependency tracking (`blocks` and `blockedBy`). It directly addresses the "cross-session/cross-subagent collaboration" problem by providing a formal way to persist context and results from one task to another.

The extension natively integrates with AiderDesk's task management system, so all "Task Flow" items appear in your Task Sidebar.

## Features

- **Cross-Task Memory**: The biggest advantage. When an agent finishes a task, it can save an "outcome" (result) that other tasks can read. The agent can also retrieve a summary of the entire conversation from another task to understand previously made decisions.
- **Memory Compaction**: Inspired by [BEADS](https://github.com/steveyegge/beads), the `TaskCompact` tool enables "memory decay" — completed tasks can be summarized into concise, high-signal summaries via LLM. This dramatically reduces context window usage when future tasks retrieve historical context.
- **Context Priming**: The `TaskPrime` tool loads consolidated context from all prerequisite tasks at once, giving the agent a full briefing before starting work — including outcomes, compacted summaries, and related task context.
- **Rich Dependency Graph**: Beyond simple `blockedBy`/`blocks`, tasks support `relatesTo` (non-blocking knowledge connections) and `discoveredFrom` (provenance tracking for work discovered during other tasks).
- **Better Organization of Complex Projects**: Allows the AI agent to independently plan multi-stage projects, preventing loss of context during large-scale changes.
- **Workflow Automation**: The extension automatically manages task states – completing a blocker task immediately unlocks dependent tasks and marks them as ready for work.
- **Efficient Subagent Collaboration**: Subagents can search existing tasks and learn from their outcomes and conversation summaries, eliminating duplicate efforts.
- **Progress Visualization**: The entire dependency tree and project flow are visible directly in the AiderDesk Task Sidebar.
- **Native AiderDesk Integration**: Fully mapped to AiderDesk's internal task model and UI states (`TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`).
- **Global Task Search**: Search across subjects, descriptions, outcomes, and compacted summaries to find historical context or identify existing plans.

## Installation

**From this repository** (recommended)

**Global** (available in all projects)

```bash
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/task-flow --global
```

**Local** (project-level)

```bash
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/task-flow
```

## How to use it?

Task Flow is used by the AI agent via these tools:

1.  **`TaskCreate`**: Used for planning. Breaks down requirements into tasks with dependencies (`addBlockedBy`, `addBlocks`), knowledge links (`relatesTo`), and provenance (`discoveredFrom`).
2.  **`TaskUpdate`**: Used for execution. **Agent provides an `outcome`** when completing a task to persist key findings.
3.  **`TaskGet`**: Used for context. **Agent uses `includeSummary: true`** to read what happened in a prerequisite task. Returns the compacted summary if available, or the full conversation. Use `fullSummary: true` to force the full version.
4.  **`TaskSearch`**: Used for discovery. Searching for existing implementations or decisions across all task fields including compacted summaries.
5.  **`TaskList`**: Overview of project flow with dependency graph and compaction status.
6.  **`TaskCompact`**: Used for memory management. **Compacts a completed task's conversation** into a concise summary via LLM, enabling efficient "memory decay". Optionally accepts `customInstructions` to focus the summary.
7.  **`TaskPrime`**: Used for context loading. **Loads consolidated briefing** from all blocker tasks, related tasks, and provenance links before starting work. Supports transitive dependency traversal via `depth` parameter.

The extension injects a critical protocol into the agent's system prompt, prioritizing cross-task context retrieval, compaction, priming, and result persistence.
