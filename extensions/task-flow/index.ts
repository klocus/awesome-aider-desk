import type {
  AgentStartedEvent,
  Extension,
  ExtensionContext,
  SubagentStartedEvent,
  TaskData,
  ToolDefinition,
} from '@aiderdesk/extensions';
import { z } from 'zod';

const TASK_FLOW_PROMPT = `
<instruction name="task-flow-protocol" policy_level="critical">
You are equipped with the Task Flow extension which provides advanced project orchestration and CROSS-TASK MEMORY for AiderDesk. You MUST use these tools to coordinate work across sessions and subagents.

AVAILABLE TOOLS:
- \`TaskCreate\`: Create a new task with dependencies (\`addBlockedBy\`, \`addBlocks\`, \`relatesTo\`, \`discoveredFrom\`).
- \`TaskUpdate\`: Update status. When marking as \`completed\`, ALWAYS provide an \`outcome\` summary.
- \`TaskGet\`: Retrieve task details. Use \`includeSummary: true\` to read context from a PREVIOUS task.
- \`TaskSearch\`: Search for tasks by keywords to find relevant historical context.
- \`TaskList\`: Get a birds-eye view of the project flow.
- \`TaskCompact\`: Compact a completed task's conversation into a concise summary. Saves context window space for future retrieval.
- \`TaskPrime\`: Load consolidated context from all blocker tasks before starting work on a task.

PROTOCOL:
1. ORCHESTRATION: Break down projects into tasks. Tasks are your "long-term memory" across sessions.
2. PRIMING: Before starting a task, use \`TaskPrime\` to load context from all blocker tasks at once.
3. CONTEXT RETRIEVAL: For deeper investigation of a specific task, use \`TaskGet(includeSummary: true)\`.
4. PERSISTENCE: When completing a task, use \`TaskUpdate(status: "completed", outcome: "...")\` to distill your work into a high-signal summary.
5. COMPACTION: After completing a significant task, use \`TaskCompact\` to create a condensed summary. This enables efficient "memory decay" — old tasks take less context window when retrieved later.
6. COORDINATION: Use \`TaskList\` regularly to identify tasks ready for implementation (status: pending, blockedBy: empty).
7. STRUCTURE: Use \`asSubtask: true\` in \`TaskCreate\` to organize work hierarchically.
8. DISCOVERY: When you discover new work during a task, use \`TaskCreate(discoveredFrom: currentTaskId)\` to track provenance.
</instruction>
`.trim();

const COMPACT_SYSTEM_PROMPT = [
  'You are a technical summarizer. Given a full conversation history of a development task, create a concise but high-signal summary that preserves:',
  '1. The task objective and final outcome',
  '2. Key technical decisions made and their rationale',
  '3. Important implementation details (files changed, APIs used, patterns chosen)',
  '4. Gotchas, edge cases, or warnings discovered',
  '5. Any open questions or follow-up items',
  '',
  'Format as structured markdown with sections. Aim for ~20% of the original length while retaining ~80% of the useful information.',
  'Do NOT include raw code blocks unless they are critical to understanding a decision.',
].join('\n');

function uniqueArray(arr: string[]): string[] {
  return [...new Set(arr)];
}

function stateFromStatus(status: string): string {
  switch (status) {
    case 'completed':
      return 'DONE';
    case 'in_progress':
      return 'IN_PROGRESS';
    case 'blocked':
      return 'BLOCKED';
    default:
      return 'TODO';
  }
}

export default class TaskFlowExtension implements Extension {
  static metadata = {
    name: 'Task Flow',
    version: '1.1.0',
    description:
      'Advanced task orchestration for AiderDesk. Adds dependency tracking, cross-task memory, and automated flow management.',
    author: 'Paweł Klockiewicz',
  };

  async onLoad(context: ExtensionContext) {
    context.log('Task Flow extension loaded.', 'info');
  }

  async onAgentStarted(
    event: AgentStartedEvent,
    _context: ExtensionContext
  ): Promise<void | Partial<AgentStartedEvent>> {
    const existing = event.systemPrompt ?? '';
    return { systemPrompt: (existing ? existing + '\n\n' : '') + TASK_FLOW_PROMPT };
  }

  // Ensure subagents also receive the protocol (systemPrompt is modifiable in SubagentStartedEvent)
  async onSubagentStarted(
    event: SubagentStartedEvent,
    _context: ExtensionContext
  ): Promise<void | Partial<SubagentStartedEvent>> {
    const existing = event.systemPrompt ?? '';
    if (!existing.includes('task-flow-protocol')) {
      return { systemPrompt: (existing ? existing + '\n\n' : '') + TASK_FLOW_PROMPT };
    }
  }

  private async updateTask(
    context: ExtensionContext,
    taskId: string,
    updates: { state?: string; metadata?: Record<string, unknown> }
  ): Promise<TaskData | null> {
    const project = context.getProjectContext();
    const taskCtx = project.getTask(taskId);
    if (!taskCtx) return null;

    const taskUpdates: Partial<TaskData> = {};
    if (updates.state !== undefined) {
      (taskUpdates as Record<string, unknown>).state = updates.state;
    }
    if (updates.metadata) {
      taskUpdates.metadata = { ...taskCtx.data.metadata, ...updates.metadata };
    }

    return await taskCtx.updateTask(taskUpdates);
  }

  private getTask(context: ExtensionContext, taskId: string): TaskData | null {
    const taskCtx = context.getProjectContext().getTask(taskId);
    return taskCtx ? taskCtx.data : null;
  }

  private async getTasks(context: ExtensionContext): Promise<TaskData[]> {
    return await context.getProjectContext().getTasks();
  }

  private async checkAndUnblockDownstreamTasks(context: ExtensionContext, completedTaskId: string) {
    const tasks = await this.getTasks(context);

    for (const task of tasks) {
      if (task.state !== 'BLOCKED') continue;

      const blockedBy = (task.metadata?.blockedBy as string[]) || [];
      if (!blockedBy.includes(completedTaskId)) continue;

      const allCompleted = blockedBy.every((blockerId) => {
        const blocker = this.getTask(context, blockerId);
        return !blocker || blocker.state === 'DONE';
      });

      if (allCompleted) {
        await this.updateTask(context, task.id, {
          state: 'TODO',
          metadata: { flowStatus: 'pending' },
        });
        context.log(`Task Flow: Auto-unblocked task "${task.name}" (${task.id})`, 'info');
      }
    }
  }

  private async buildBriefing(
    context: ExtensionContext,
    taskIds: string[],
    depth: number,
    visited: Set<string>,
  ): Promise<string> {
    const sections: string[] = [];

    for (const taskId of taskIds) {
      if (visited.has(taskId)) continue;
      visited.add(taskId);

      const taskCtx = context.getProjectContext().getTask(taskId);
      if (!taskCtx) continue;

      const task = taskCtx.data;
      const meta = task.metadata || {};
      const outcome = meta.outcome as string | null;
      const compactedSummary = meta.compactedSummary as string | null;
      const description = meta.description as string | null;
      const flowStatus = (meta.flowStatus as string) || 'unknown';

      let section = `### ${task.name} (\`${taskId}\`) — ${flowStatus}\n`;
      if (description) section += `**Description:** ${description}\n`;
      if (outcome) section += `**Outcome:** ${outcome}\n`;

      if (compactedSummary) {
        section += `**Compacted Summary:**\n${compactedSummary}\n`;
      } else if (flowStatus === 'completed' && !outcome) {
        const fullSummary = await taskCtx.generateContextMarkdown();
        if (fullSummary) {
          section += `**Conversation excerpt:** ${fullSummary.substring(0, 500)}…\n`;
        }
      }

      sections.push(section);

      if (depth > 1) {
        const blockerIds = (meta.blockedBy as string[]) || [];
        if (blockerIds.length > 0) {
          const subBriefing = await this.buildBriefing(context, blockerIds, depth - 1, visited);
          if (subBriefing) sections.push(subBriefing);
        }
      }
    }

    return sections.join('\n---\n\n');
  }

  getTools(_context: ExtensionContext, _mode?: string, _agentProfile?: unknown): ToolDefinition[] {
    const taskCreateSchema = z.object({
      subject: z.string().describe('The title of the task'),
      description: z.string().describe('Detailed description'),
      activeForm: z.string().describe('Present-tense description of work'),
      addBlockedBy: z.array(z.string()).optional().describe('IDs of tasks that must complete before this one'),
      addBlocks: z.array(z.string()).optional().describe('IDs of tasks that this one blocks'),
      relatesTo: z.array(z.string()).optional().describe('IDs of related tasks (non-blocking knowledge connection)'),
      discoveredFrom: z.string().optional().describe('ID of the task during which this new work was discovered'),
      asSubtask: z.boolean().optional().describe('Create as a subtask of the current task'),
    });

    const taskGetSchema = z.object({
      id: z.string().describe('Task ID to retrieve'),
      includeSummary: z
        .boolean()
        .optional()
        .describe('If true, returns the compacted summary (if available) or generates a conversation markdown.'),
      fullSummary: z
        .boolean()
        .optional()
        .describe('If true, always generates the full conversation markdown even when a compacted summary exists.'),
    });

    const taskUpdateSchema = z.object({
      id: z.string().describe('Task ID to update'),
      status: z.enum(['pending', 'in_progress', 'blocked', 'completed']).optional().describe('New status'),
      outcome: z.string().optional().describe('Summary of the results/decisions made in this task.'),
      owner: z.string().optional().describe('Owner/assignee of the task'),
    });

    const taskSearchSchema = z.object({
      query: z.string().describe('Keywords to search for in task names, descriptions, and outcomes'),
    });

    const taskListSchema = z.object({
      status: z.enum(['pending', 'in_progress', 'blocked', 'completed']).optional().describe('Filter by status'),
    });

    const taskCompactSchema = z.object({
      id: z.string().describe('Task ID to compact'),
      customInstructions: z
        .string()
        .optional()
        .describe('Additional instructions for what to focus on in the summary'),
    });

    const taskPrimeSchema = z.object({
      id: z.string().optional().describe('Task ID to prime context for (defaults to current task)'),
      depth: z
        .number()
        .optional()
        .describe('How many levels of transitive dependencies to traverse (default: 1)'),
    });

    return [
      {
        name: 'TaskCreate',
        description: 'Creates a new Task Flow task with dependency tracking.',
        inputSchema: taskCreateSchema,
        execute: async (input, _signal, ctx) => {
          const { subject, description, activeForm, addBlockedBy, addBlocks, relatesTo, discoveredFrom, asSubtask } =
            input as z.infer<typeof taskCreateSchema>;
          try {
            const project = ctx.getProjectContext();
            const currentTaskCtx = ctx.getTaskContext();
            const parentId = asSubtask && currentTaskCtx ? currentTaskCtx.data.id : null;

            const isBlocked = addBlockedBy && addBlockedBy.length > 0;
            const taskData = await project.createTask({ name: subject, parentId });

            const metadata: Record<string, unknown> = {
              description,
              activeForm,
              flowStatus: isBlocked ? 'blocked' : 'pending',
              blockedBy: addBlockedBy || [],
              blocks: addBlocks || [],
              relatesTo: relatesTo || [],
              discoveredFrom: discoveredFrom || null,
              discoveries: [],
              outcome: null,
              compactedSummary: null,
              compactedAt: null,
            };

            await this.updateTask(ctx, taskData.id, {
              state: isBlocked ? 'BLOCKED' : 'TODO',
              metadata,
            });

            // Bidirectional dependency linking with deduplication
            if (addBlocks) {
              for (const blockedId of addBlocks) {
                const t = this.getTask(ctx, blockedId);
                if (t) {
                  const existing = (t.metadata?.blockedBy as string[]) || [];
                  await this.updateTask(ctx, blockedId, {
                    state: 'BLOCKED',
                    metadata: {
                      blockedBy: uniqueArray([...existing, taskData.id]),
                      flowStatus: 'blocked',
                    },
                  });
                }
              }
            }

            if (addBlockedBy) {
              for (const blockerId of addBlockedBy) {
                const t = this.getTask(ctx, blockerId);
                if (t) {
                  const existing = (t.metadata?.blocks as string[]) || [];
                  await this.updateTask(ctx, blockerId, {
                    metadata: { blocks: uniqueArray([...existing, taskData.id]) },
                  });
                }
              }
            }

            if (relatesTo) {
              for (const relatedId of relatesTo) {
                const t = this.getTask(ctx, relatedId);
                if (t) {
                  const existing = (t.metadata?.relatesTo as string[]) || [];
                  await this.updateTask(ctx, relatedId, {
                    metadata: { relatesTo: uniqueArray([...existing, taskData.id]) },
                  });
                }
              }
            }

            if (discoveredFrom) {
              const t = this.getTask(ctx, discoveredFrom);
              if (t) {
                const existing = (t.metadata?.discoveries as string[]) || [];
                await this.updateTask(ctx, discoveredFrom, {
                  metadata: { discoveries: uniqueArray([...existing, taskData.id]) },
                });
              }
            }

            return { content: [{ type: 'text', text: `Task created: ${taskData.id}` }] };
          } catch (error) {
            return {
              isError: true,
              content: [
                { type: 'text', text: `Failed to create task: ${error instanceof Error ? error.message : String(error)}` },
              ],
            };
          }
        },
      },
      {
        name: 'TaskGet',
        description: 'Retrieves task details and optional conversation summary for cross-task learning.',
        inputSchema: taskGetSchema,
        execute: async (input, _signal, ctx) => {
          const { id, includeSummary, fullSummary } = input as z.infer<typeof taskGetSchema>;
          try {
            const project = ctx.getProjectContext();
            const taskCtx = project.getTask(id);
            if (!taskCtx) {
              return { isError: true, content: [{ type: 'text', text: 'Task not found.' }] };
            }

            let conversationSummary: string | undefined;
            if (includeSummary || fullSummary) {
              const compacted = taskCtx.data.metadata?.compactedSummary as string | null;
              if (compacted && !fullSummary) {
                conversationSummary = compacted;
              } else {
                conversationSummary = (await taskCtx.generateContextMarkdown()) || 'No conversation history.';
              }
            }

            return {
              content: [{ type: 'text', text: JSON.stringify({ ...taskCtx.data, conversationSummary }, null, 2) }],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                { type: 'text', text: `Failed to get task: ${error instanceof Error ? error.message : String(error)}` },
              ],
            };
          }
        },
      },
      {
        name: 'TaskUpdate',
        description: 'Updates task status. Use "outcome" to save a summary of results when completing.',
        inputSchema: taskUpdateSchema,
        execute: async (input, _signal, ctx) => {
          const { id, status, outcome, owner } = input as z.infer<typeof taskUpdateSchema>;
          try {
            const task = this.getTask(ctx, id);
            if (!task) {
              return { isError: true, content: [{ type: 'text', text: 'Task not found.' }] };
            }

            const metadataUpdates: Record<string, unknown> = {};
            let newState: string | undefined;

            if (status) {
              metadataUpdates.flowStatus = status;
              newState = stateFromStatus(status);
            }
            if (outcome !== undefined) metadataUpdates.outcome = outcome;
            if (owner !== undefined) metadataUpdates.owner = owner;

            const hasStateChange = newState !== undefined && newState !== task.state;
            const hasMetadataChange = Object.keys(metadataUpdates).length > 0;

            if (hasStateChange || hasMetadataChange) {
              await this.updateTask(ctx, task.id, {
                state: hasStateChange ? newState : undefined,
                metadata: hasMetadataChange ? metadataUpdates : undefined,
              });
            }

            if (status === 'completed') {
              await this.checkAndUnblockDownstreamTasks(ctx, task.id);
            }

            return { content: [{ type: 'text', text: 'Task updated.' }] };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      {
        name: 'TaskSearch',
        description: 'Search for tasks by subject, description, or outcome to find historical context.',
        inputSchema: taskSearchSchema,
        execute: async (input, _signal, ctx) => {
          const { query } = input as z.infer<typeof taskSearchSchema>;
          try {
            const tasks = await this.getTasks(ctx);
            const keywords = query
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean);

            const results = tasks
              .filter((t) => {
                const searchable = [
                  t.name,
                  (t.metadata?.description as string) || '',
                  (t.metadata?.outcome as string) || '',
                  (t.metadata?.compactedSummary as string) || '',
                ]
                  .join(' ')
                  .toLowerCase();
                return keywords.some((kw) => searchable.includes(kw));
              })
              .map((t) => ({
                id: t.id,
                subject: t.name,
                status: t.metadata?.flowStatus || 'pending',
                outcome: t.metadata?.outcome || null,
              }));

            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Failed to search tasks: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      {
        name: 'TaskList',
        description: 'List all project tasks with their flow status and dependencies.',
        inputSchema: taskListSchema,
        execute: async (input, _signal, ctx) => {
          const { status } = input as z.infer<typeof taskListSchema>;
          try {
            let tasks = await this.getTasks(ctx);
            if (status) {
              tasks = tasks.filter((t) => t.metadata?.flowStatus === status);
            }

            const results = tasks.map((t) => ({
              id: t.id,
              subject: t.name,
              flowStatus: t.metadata?.flowStatus || 'pending',
              owner: t.metadata?.owner || null,
              blockedBy: t.metadata?.blockedBy || [],
              blocks: t.metadata?.blocks || [],
              relatesTo: t.metadata?.relatesTo || [],
              discoveredFrom: t.metadata?.discoveredFrom || null,
              hasCompactedSummary: !!t.metadata?.compactedSummary,
            }));

            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      {
        name: 'TaskCompact',
        description:
          'Compact a completed task conversation into a concise summary for efficient cross-task memory. Reduces context window usage when the task is later retrieved via TaskGet or TaskPrime.',
        inputSchema: taskCompactSchema,
        execute: async (input, _signal, ctx) => {
          const { id, customInstructions } = input as z.infer<typeof taskCompactSchema>;
          try {
            const project = ctx.getProjectContext();
            const taskCtx = project.getTask(id);
            if (!taskCtx) {
              return { isError: true, content: [{ type: 'text', text: 'Task not found.' }] };
            }

            const fullConversation = await taskCtx.generateContextMarkdown();
            if (!fullConversation) {
              return {
                isError: true,
                content: [{ type: 'text', text: 'No conversation history to compact.' }],
              };
            }

            let profile = await taskCtx.getTaskAgentProfile();
            if (!profile) {
              const currentTaskCtx = ctx.getTaskContext();
              profile = currentTaskCtx ? await currentTaskCtx.getTaskAgentProfile() : null;
            }
            if (!profile) {
              return {
                isError: true,
                content: [{ type: 'text', text: 'Cannot determine agent profile for text generation.' }],
              };
            }

            const systemPrompt =
              COMPACT_SYSTEM_PROMPT +
              (customInstructions ? `\n\nAdditional focus: ${customInstructions}` : '');

            const compactedSummary = await taskCtx.generateText(profile, systemPrompt, fullConversation);
            if (!compactedSummary) {
              return {
                isError: true,
                content: [{ type: 'text', text: 'Failed to generate compacted summary.' }],
              };
            }

            await this.updateTask(ctx, id, {
              metadata: {
                compactedSummary,
                compactedAt: new Date().toISOString(),
              },
            });

            const ratio = Math.round((compactedSummary.length / fullConversation.length) * 100);
            return {
              content: [
                {
                  type: 'text',
                  text: `Task compacted. Summary: ${compactedSummary.length} chars (${ratio}% of original ${fullConversation.length} chars).`,
                },
              ],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Failed to compact task: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
      {
        name: 'TaskPrime',
        description:
          'Load consolidated context from all prerequisite (blocker) tasks. Returns outcomes and summaries from the dependency chain to prime the agent before starting work.',
        inputSchema: taskPrimeSchema,
        execute: async (input, _signal, ctx) => {
          const { id, depth } = input as z.infer<typeof taskPrimeSchema>;
          try {
            let taskId = id;
            if (!taskId) {
              const currentTask = ctx.getTaskContext();
              if (!currentTask) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: 'No current task and no ID provided.' }],
                };
              }
              taskId = currentTask.data.id;
            }

            const task = this.getTask(ctx, taskId);
            if (!task) {
              return { isError: true, content: [{ type: 'text', text: 'Task not found.' }] };
            }

            const meta = task.metadata || {};
            const blockerIds = (meta.blockedBy as string[]) || [];
            const relatedIds = (meta.relatesTo as string[]) || [];
            const discoveredFromId = meta.discoveredFrom as string | null;

            const parts: string[] = [];
            parts.push(`# Context Briefing: ${task.name}\n`);
            parts.push(`**Your task:** ${(meta.description as string) || task.name}\n`);

            if (blockerIds.length > 0) {
              parts.push(`## Prerequisite Task Results\n`);
              const briefing = await this.buildBriefing(ctx, blockerIds, depth ?? 1, new Set());
              parts.push(briefing);
            }

            if (relatedIds.length > 0) {
              parts.push(`\n## Related Tasks\n`);
              for (const relId of relatedIds) {
                const rel = this.getTask(ctx, relId);
                if (rel) {
                  const relMeta = rel.metadata || {};
                  parts.push(
                    `- **${rel.name}** (\`${relId}\`) — ${relMeta.flowStatus || 'unknown'}: ${(relMeta.outcome as string) || (relMeta.description as string) || 'No details'}`,
                  );
                }
              }
            }

            if (discoveredFromId) {
              const src = this.getTask(ctx, discoveredFromId);
              if (src) {
                parts.push(
                  `\n## Provenance\nThis task was discovered during work on: **${src.name}** (\`${discoveredFromId}\`)`,
                );
              }
            }

            if (blockerIds.length === 0 && relatedIds.length === 0 && !discoveredFromId) {
              parts.push('\n_No dependencies, related tasks, or provenance links found._');
            }

            return { content: [{ type: 'text', text: parts.join('\n') }] };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Failed to prime context: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        },
      },
    ];
  }
}
