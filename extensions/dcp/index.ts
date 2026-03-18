import type {
  AgentProfile,
  AgentStartedEvent,
  CommandDefinition,
  ContextAssistantMessage,
  ContextMessage,
  ContextToolMessage,
  Extension,
  ExtensionContext,
  OptimizeMessagesEvent,
  ToolDefinition,
  ToolResultOutput,
  ToolResultPart
} from '@aiderdesk/extensions';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

// --- Config ---

interface DcpConfig {
  enabled: boolean;
  manualMode: boolean;
  protectedTools: string[];
  tools: {
    nudgeEnabled: boolean;
    nudgeFrequency: number;
    distill: boolean;
    prune: boolean;
  };
  strategies: {
    deduplication: { enabled: boolean };
    supersedeWrites: { enabled: boolean };
    purgeErrors: { enabled: boolean; turns: number };
  };
}

function loadConfig(): DcpConfig {
  const configPath = join(__dirname, 'config.json');
  const raw = readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as DcpConfig;
}

// --- Constants ---

const PRUNED_ERROR_INPUT = '[DCP: Input removed — failed tool call]';

/**
 * Tools whose outputs should never be pruned (blacklist approach).
 * Deduplication & error purging run on ALL tools except these.
 * Matches against the full tool name using substring checks.
 */
const PROTECTED_TOOL_PATTERNS = [
  // DCP's own tools
  'dcp-prune',
  'dcp-distill',
  // AiderDesk native tool groups — these should never be pruned as they manage core task state
  'tasks---',
  'todo---',
  'skills---',
  'memory---',
  'subagents---',
  // Aider code generation — unique creative output, not idempotent
  'run_prompt',
  // Aider context file management — tracks which files are in context
  'get_context_files',
  'add_context_files',
  'drop_context_files'
];

function buildSystemPrompt(distillEnabled: boolean, pruneEnabled: boolean): string {
  const toolList: string[] = [];
  if (distillEnabled)
    toolList.push(
      "`dcp-distill`: condense key findings from tool calls into high-fidelity distillation to preserve gained insights. Use to extract valuable knowledge to the user's request. BE THOROUGH, your distillation MUST be high-signal, low noise and complete."
    );
  if (pruneEnabled)
    toolList.push(
      '`dcp-prune`: remove individual tool calls that are noise, irrelevant, or superseded. No preservation of content. DO NOT let irrelevant tool calls accumulate. DO NOT PRUNE TOOL OUTPUTS THAT YOU MAY NEED LATER.'
    );

  const distillSection = distillEnabled
    ? `

THE DISTILL TOOL
\`dcp-distill\` is the favored way to target specific tools and crystalize their value into high-signal low-noise knowledge nuggets. Your distillation must be comprehensive, capturing technical details (symbols, signatures, logic, constraints) such that the raw output is no longer needed. THINK complete technical substitute. \`dcp-distill\` is typically best used when you are certain the raw information is not needed anymore, but the knowledge it contains is valuable to retain so you maintain context authenticity and understanding. Be conservative in your approach to distilling, but do NOT hesitate to distill when appropriate.`
    : '';

  const pruneSection = pruneEnabled
    ? `

THE PRUNE TOOL
\`dcp-prune\` is your last resort for context management. It is a blunt instrument that removes tool outputs entirely, without ANY preservation. It is best used to eliminate noise, irrelevant information, or superseded outputs that no longer add value to the conversation. You MUST NOT prune tool outputs that you may need later. Prune is a targeted nuke, not a general cleanup tool. Contemplate only pruning when you are certain that the tool output is irrelevant to the current task or has been superseded by more recent information. If in doubt, defer until you are definitive.`
    : '';

  return `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
You operate a context-constrained environment and MUST PROACTIVELY MANAGE IT TO AVOID CONTEXT ROT. Efficient context management is CRITICAL to maintaining performance and ensuring successful task completion.

AVAILABLE TOOLS FOR CONTEXT MANAGEMENT
${toolList.join('\n')}${distillSection}${pruneSection}

TIMING
Prefer managing context at the START of a new agentic loop (after receiving a user message) rather than at the END of your previous turn. At turn start, you have fresh signal about what the user needs next - you can better judge what's still relevant versus noise from prior work. Managing at turn end means making retention decisions before knowing what comes next.

EVALUATE YOUR CONTEXT AND MANAGE REGULARLY TO AVOID CONTEXT ROT. AVOID USING MANAGEMENT TOOLS AS THE ONLY TOOL CALLS IN YOUR RESPONSE, PARALLELIZE WITH OTHER RELEVANT TOOLS TO TASK CONTINUATION. It is imperative you understand the value or lack thereof of the context you manage and make informed decisions to maintain a decluttered, high-quality and relevant context.

The session is your responsibility, and effective context management is CRITICAL to your success. Be PROACTIVE, DELIBERATE, and STRATEGIC in your approach to context management. Keep it clean, relevant, and high-quality to ensure optimal performance and successful task completion.

Be respectful of the user's API usage, manage context methodically as you work through the task and avoid calling ONLY context management tools in your responses.
</instruction>

<instruction name=injected_context_handling policy_level=critical>
This chat environment injects context information on your behalf in the form of a <prunable-tools> list to help you manage context effectively. Carefully read the list and use it to inform your management decisions. The list is automatically updated after each turn to reflect the current state of manageable tools and context usage. If no list is present, do NOT attempt to prune anything.
There may be tools in session context that do not appear in the <prunable-tools> list — this is expected. You can ONLY prune what you see in the list.
</instruction>
</system-reminder>`.trim();
}

function buildNudge(distillEnabled: boolean, pruneEnabled: boolean): string {
  const actions: string[] = [];
  if (distillEnabled)
    actions.push(
      'KNOWLEDGE PRESERVATION: If holding valuable raw data you POTENTIALLY will need in your task, use the `dcp-distill` tool. Produce a high-fidelity distillation to preserve insights - be thorough.'
    );
  if (pruneEnabled)
    actions.push(
      'NOISE REMOVAL: If you read files or ran commands that yielded no value, use the `dcp-prune` tool to remove them. If newer tools supersede older ones, prune the old.'
    );
  return `<instruction name=context_management_required>
CRITICAL CONTEXT WARNING
Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

PROTOCOL
You should prioritize context management, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must perform context management.

IMMEDIATE ACTION REQUIRED
${actions.join('\n')}
</instruction>`.trim();
}

function buildCooldown(distillEnabled: boolean, pruneEnabled: boolean): string {
  const tools = [distillEnabled && 'dcp-distill', pruneEnabled && 'dcp-prune'].filter(Boolean).join(' or ');
  return `<context-info>Context management was just performed. Do NOT use ${tools} again this turn. A fresh prunable-tools list will be available after your next tool use.</context-info>`;
}

// --- Helpers ---

interface DistilledRange {
  startId: string;
  endId: string;
  summary: string;
}

interface ToolCallRef {
  input: unknown;
  msgIndex: number;
  partIndex: number;
}

/** Normalize and sort object keys for stable deduplication signatures */
function normalizeForSignature(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(normalizeForSignature);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    const v = (val as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) sorted[key] = normalizeForSignature(v);
  }
  return sorted;
}

function toolSignature(toolName: string, input: unknown): string {
  if (input === undefined) return toolName;
  return `${toolName}::${JSON.stringify(normalizeForSignature(input))}`;
}

/** Detects tools that modify file contents or produce non-idempotent output */
function isWriteTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    // AiderDesk power tools
    n.includes('file_write') || // power---file_write
    n.includes('file_edit') || // power---file_edit
    // AiderDesk Aider tools
    n.includes('run_prompt') || // run_prompt — Aider code generation, not idempotent
    // Shell execution — not idempotent and has side effects, must never be deduped
    n.includes('bash') || // power---bash
    // Generic write patterns (MCP servers, other tools)
    n.includes('write_file') ||
    n.includes('edit_file') ||
    n.includes('create_file') ||
    n.includes('file_create') ||
    n.includes('replace_in_file') ||
    n.includes('replace_string') ||
    n.includes('apply_patch') ||
    n.includes('apply_diff') ||
    n.includes('insert_code') ||
    n.includes('multi_edit') ||
    n.includes('multiedit') ||
    n === 'write' ||
    n === 'edit'
  );
}

/** Detects tools that read file contents or search the filesystem */
function isReadTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    // AiderDesk power tools
    n.includes('file_read') || // power---file_read
    n.includes('grep') || // power---grep
    n.includes('glob') || // power---glob
    n.includes('semantic_search') || // power---semantic_search
    n.includes('fetch') || // power---fetch — reads web content
    // AiderDesk Aider tools
    n.includes('get_context_files') || // get_context_files — lists files in Aider context
    // Generic read/search patterns (MCP servers, other tools)
    n.includes('read_file') ||
    n.includes('search') || // also covers semantic_search, search_task etc.
    n.includes('find') ||
    n.includes('list_dir') ||
    n.includes('list_file') ||
    n.includes('cat') ||
    n.includes('view') ||
    n === 'read'
  );
}

function outputSize(output: ToolResultOutput): number {
  if (output.type === 'text' || output.type === 'error-text') return output.value.length;
  if (output.type === 'json' || output.type === 'error-json') return JSON.stringify(output.value).length;
  if (output.type === 'content') return JSON.stringify(output.value).length;
  return 0;
}

function extractPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const p = input.filePath ?? input.path ?? input.file ?? input.filePattern ?? input.pattern ?? input.filename;
  return typeof p === 'string' ? p : undefined;
}

// --- Extension ---

export default class DCPExtension implements Extension {
  static metadata = {
    name: 'Dynamic Context Pruning',
    version: '1.1.0',
    description: 'Automatically manages conversation context to optimize token usage',
    author: 'Paweł Klockiewicz',
    capabilities: ['tools', 'commands', 'events']
  };

  private stats = { prunedParts: 0, estimatedTokensSaved: 0 };
  private seenToolCallIds = new Set<string>();
  private manuallyPrunedIds = new Set<string>();
  private distilledRanges: DistilledRange[] = [];
  private lastToolWasDcp = false;
  private nudgeCounter = 0;
  private config!: DcpConfig;

  /** Check if a tool should be protected from pruning based on patterns + config list */
  private isProtectedTool(name: string): boolean {
    const all = [...PROTECTED_TOOL_PATTERNS, ...this.config.protectedTools];
    return all.some(p => name === p || name.includes(p));
  }

  async onLoad(context: ExtensionContext): Promise<void> {
    this.config = loadConfig();
    context.log(`🧹 DCP: Extension loaded (enabled=${this.config.enabled}, manual=${this.config.manualMode})`, 'info');
  }

  async onUnload(): Promise<void> {
    this.stats = { prunedParts: 0, estimatedTokensSaved: 0 };
    this.seenToolCallIds.clear();
    this.manuallyPrunedIds.clear();
    this.distilledRanges = [];
    this.lastToolWasDcp = false;
    this.nudgeCounter = 0;
  }

  // --- Internal helpers ---

  /** Replace a single tool result part's output with a pruned placeholder. */
  private prunePart(part: ToolResultPart, reason: string): ToolResultPart {
    const alreadyPruned = part.output.type === 'text' && part.output.value.startsWith('[DCP:');
    if (alreadyPruned) return part;

    const placeholder = `[DCP: ${reason}]`;

    // Only count stats on first encounter
    if (!this.seenToolCallIds.has(part.toolCallId)) {
      this.seenToolCallIds.add(part.toolCallId);
      const saved = Math.max(0, Math.floor((outputSize(part.output) - placeholder.length) / 4));
      this.stats.estimatedTokensSaved += saved;
      this.stats.prunedParts++;
    }

    return { ...part, output: { type: 'text' as const, value: placeholder } };
  }

  /** Prune all parts in a tool message, respecting protected tools. */
  private pruneToolMessage(msg: ContextToolMessage, reason: string): { msg: ContextToolMessage; count: number } {
    let count = 0;
    const newContent = msg.content.map(part => {
      if (this.isProtectedTool(part.toolName)) return part;
      const pruned = this.prunePart(part, reason);
      if (pruned !== part) count++;
      return pruned;
    });
    return { msg: count > 0 ? { ...msg, content: newContent } : msg, count };
  }

  /** Build <prunable-tools> context listing tool messages available for pruning/distilling. */
  private buildPrunableToolsContext(messages: ContextMessage[], toolCalls: Map<string, ToolCallRef>): string | null {
    // Check if the last assistant response used DCP tools — if so, inject cooldown
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant && Array.isArray(lastAssistant.content)) {
      const parts = lastAssistant.content as { type: string; toolName?: string }[];
      const hasDcpTool = parts.some(
        p => p.type === 'tool-call' && (p.toolName === 'dcp-prune' || p.toolName === 'dcp-distill')
      );
      if (hasDcpTool) {
        this.lastToolWasDcp = true;
        return buildCooldown(this.config.tools.distill, this.config.tools.prune);
      }
    }

    if (this.lastToolWasDcp) {
      this.lastToolWasDcp = false;
    }

    const lines: string[] = [];
    let firstMsgId: string | null = null;
    let lastMsgId: string | null = null;

    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      // Skip messages without a valid id — prevents "undefined" leaking to the agent
      if (!msg.id) continue;
      const toolMsg = msg as ContextToolMessage;

      for (const part of toolMsg.content) {
        // Skip already pruned
        if (part.output.type === 'text' && part.output.value.startsWith('[DCP:')) continue;
        // Skip protected
        if (this.isProtectedTool(part.toolName)) continue;

        const size = outputSize(part.output);
        if (size < 50) continue; // too small to matter

        const ref = toolCalls.get(part.toolCallId);
        const filePath = extractPath(ref?.input as Record<string, unknown> | undefined);
        const description = filePath ? `${part.toolName}, ${filePath}` : part.toolName;
        const tokenEstimate = Math.ceil(size / 4);

        lines.push(`${msg.id}: ${description} (~${tokenEstimate} tokens)`);

        if (!firstMsgId) firstMsgId = msg.id;
        lastMsgId = msg.id;
      }
    }

    if (lines.length === 0) return null;

    this.nudgeCounter++;
    const nudgeEnabled = this.config.tools.nudgeEnabled && !this.config.manualMode;
    const needsNudge = nudgeEnabled && this.nudgeCounter >= this.config.tools.nudgeFrequency;
    if (needsNudge) this.nudgeCounter = 0;

    const parts: string[] = [];

    parts.push(
      `<prunable-tools>\nThe following tool messages are available for pruning/distilling. Use their IDs with dcp-prune (messageIds) or dcp-distill (range startId/endId).\n${lines.join('\n')}\n</prunable-tools>`
    );

    if (firstMsgId && lastMsgId && firstMsgId !== lastMsgId) {
      parts.push(`<distill-range>Available range: startId="${firstMsgId}" endId="${lastMsgId}"</distill-range>`);
    }

    if (needsNudge) {
      parts.push(buildNudge(this.config.tools.distill, this.config.tools.prune));
    }

    return parts.join('\n');
  }

  // --- Hooks ---

  /** Inject DCP instructions into the system prompt before each agent session. */
  async onAgentStarted(
    event: AgentStartedEvent,
    _context: ExtensionContext
  ): Promise<void | Partial<AgentStartedEvent>> {
    const distillEnabled = this.config.tools.distill;
    const pruneEnabled = this.config.tools.prune;
    if (!this.config.enabled || this.config.manualMode || (!distillEnabled && !pruneEnabled)) return;
    const existing = event.systemPrompt ?? '';
    const separator = existing ? '\n\n' : '';
    return { systemPrompt: existing + separator + buildSystemPrompt(distillEnabled, pruneEnabled) };
  }

  /** Main pruning pass — runs before every LLM call */
  async onOptimizeMessages(
    event: OptimizeMessagesEvent,
    context: ExtensionContext
  ): Promise<void | Partial<OptimizeMessagesEvent>> {
    if (!this.config.enabled) return;
    try {
      return this.runPruning(event, context);
    } catch (err) {
      context.log(`🧹 DCP: Error during pruning — ${err}`, 'error');
      return undefined;
    }
  }

  private runPruning(
    event: OptimizeMessagesEvent,
    context: ExtensionContext
  ): Partial<OptimizeMessagesEvent> | undefined {
    const messages: ContextMessage[] = [...event.optimizedMessages];
    let changed = false;
    const counts = { duplicate: 0, supersede: 0, error: 0, manual: 0, distill: 0 };
    const seenSizeBefore = this.seenToolCallIds.size;

    // --- Phase 0: Build tool call lookup from assistant messages ---
    const toolCalls = new Map<string, ToolCallRef>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const parts = msg.content as { type: string; toolCallId?: string; input?: unknown }[];
        for (let j = 0; j < parts.length; j++) {
          const part = parts[j];
          if (part.type === 'tool-call' && part.toolCallId) {
            toolCalls.set(part.toolCallId, { input: part.input, msgIndex: i, partIndex: j });
          }
        }
      }
    }

    // --- Phase 1: Distillation ranges ---
    for (const range of this.distilledRanges) {
      // Find indices for both IDs
      const startIndex = messages.findIndex(m => m.id === range.startId);
      const endIndex = messages.findIndex(m => m.id === range.endId);

      // Handle edge cases: one or both IDs not found
      if (startIndex === -1 || endIndex === -1) {
        // Range references a message that's no longer in context
        continue;
      }

      // Auto-correct reversed order
      const fromIndex = Math.min(startIndex, endIndex);
      const toIndex = Math.max(startIndex, endIndex);

      // Only iterate within the computed range boundaries
      for (let i = fromIndex; i <= toIndex; i++) {
        const msg = messages[i];
        if (msg.role === 'tool') {
          const { msg: pruned, count } = this.pruneToolMessage(
            msg as ContextToolMessage,
            `distilled — ${range.summary}`
          );
          if (count > 0) {
            messages[i] = pruned;
            counts.distill += count;
            changed = true;
          }
        }
      }
    }

    // --- Phase 2: Manual prunes ---
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'tool' && this.manuallyPrunedIds.has(msg.id)) {
        const { msg: pruned, count } = this.pruneToolMessage(msg as ContextToolMessage, 'manually pruned');
        if (count > 0) {
          messages[i] = pruned;
          counts.manual += count;
          changed = true;
        }
      }
    }

    // --- Phase 3: Deduplication — keep only the latest occurrence of identical tool calls ---
    if (this.config.strategies.deduplication.enabled) {
      const sigRegistry = new Map<string, { msgIndex: number; partIndex: number }>();
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== 'tool') continue;
        const toolMsg = messages[i] as ContextToolMessage;
        for (let j = 0; j < toolMsg.content.length; j++) {
          const part = toolMsg.content[j];
          if (part.output.type === 'text' && part.output.value.startsWith('[DCP:')) continue;
          if (this.isProtectedTool(part.toolName)) continue;
          // Don't dedup write/edit tools — same params doesn't mean same result (file may have changed)
          if (isWriteTool(part.toolName)) continue;

          const ref = toolCalls.get(part.toolCallId);
          const sig = toolSignature(part.toolName, ref?.input);
          const prev = sigRegistry.get(sig);

          if (prev) {
            const prevMsg = messages[prev.msgIndex] as ContextToolMessage;
            const prevPart = prevMsg.content[prev.partIndex];
            if (!(prevPart.output.type === 'text' && prevPart.output.value.startsWith('[DCP:'))) {
              const prunedPart = this.prunePart(prevPart, 'superseded by later identical call');
              if (prunedPart !== prevPart) {
                const newContent = [...prevMsg.content];
                newContent[prev.partIndex] = prunedPart;
                messages[prev.msgIndex] = { ...prevMsg, content: newContent };
                counts.duplicate++;
                changed = true;
              }
            }
          }
          sigRegistry.set(sig, { msgIndex: i, partIndex: j });
        }
      }
    } // end deduplication

    // --- Phase 4: Supersede writes — prune earlier writes when file was later read ---
    if (this.config.strategies.supersedeWrites.enabled) {
      const fileWrites = new Map<string, { msgIndex: number; partIndex: number }>();
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== 'tool') continue;
        const toolMsg = messages[i] as ContextToolMessage;
        for (let j = 0; j < toolMsg.content.length; j++) {
          const part = toolMsg.content[j];
          if (part.output.type === 'text' && part.output.value.startsWith('[DCP:')) continue;

          const ref = toolCalls.get(part.toolCallId);
          const filePath = extractPath(ref?.input as Record<string, unknown> | undefined);
          if (!filePath) continue;

          if (isWriteTool(part.toolName)) {
            fileWrites.set(filePath, { msgIndex: i, partIndex: j });
          } else if (isReadTool(part.toolName) && fileWrites.has(filePath)) {
            const prev = fileWrites.get(filePath)!;
            const prevMsg = messages[prev.msgIndex] as ContextToolMessage;
            const prevPart = prevMsg.content[prev.partIndex];
            if (!(prevPart.output.type === 'text' && prevPart.output.value.startsWith('[DCP:'))) {
              const prunedPart = this.prunePart(prevPart, 'write superseded by later read');
              if (prunedPart !== prevPart) {
                const newContent = [...prevMsg.content];
                newContent[prev.partIndex] = prunedPart;
                messages[prev.msgIndex] = { ...prevMsg, content: newContent };
                counts.supersede++;
                changed = true;
              }
            }
            fileWrites.delete(filePath);
          }
        }
      }
    } // end supersedeWrites

    // --- Phase 5: Purge error inputs — prune large string inputs from assistant messages for errored tool calls ---
    if (this.config.strategies.purgeErrors.enabled) {
      const purgeErrorTurns = this.config.strategies.purgeErrors.turns;
      const userTurnsTotal = messages.filter(m => m.role === 'user').length;
      const erroredIds = new Set<string>();

      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== 'tool') continue;
        const toolMsg = messages[i] as ContextToolMessage;
        for (const part of toolMsg.content) {
          if (this.isProtectedTool(part.toolName)) continue;
          const isError = part.output.type === 'error-text' || part.output.type === 'error-json';
          if (!isError) continue;
          const turnsAt = messages.slice(0, i).filter(m => m.role === 'user').length;
          if (userTurnsTotal - turnsAt >= purgeErrorTurns) {
            erroredIds.add(part.toolCallId);
          }
        }
      }

      if (erroredIds.size > 0) {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

          const asstMsg = msg as ContextAssistantMessage;
          let msgModified = false;
          const contentArr = asstMsg.content as unknown as { type: string; toolCallId?: string; input?: unknown }[];
          const newContent = contentArr.map(part => {
            if (part.type !== 'tool-call' || !erroredIds.has(part.toolCallId as string)) return part;

            const input = part.input;
            if (!input || typeof input !== 'object') return part;

            let inputModified = false;
            const prunedInput: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
              if (typeof val === 'string' && val.length > 100) {
                prunedInput[key] = PRUNED_ERROR_INPUT;
                inputModified = true;
              } else {
                prunedInput[key] = val;
              }
            }
            if (!inputModified) return part;

            // Count stats only once per tool call
            const countKey = `err:${part.toolCallId}`;
            if (!this.seenToolCallIds.has(countKey)) {
              this.seenToolCallIds.add(countKey);
              const inputSize = JSON.stringify(input).length;
              const prunedSize = JSON.stringify(prunedInput).length;
              this.stats.estimatedTokensSaved += Math.max(0, Math.floor((inputSize - prunedSize) / 4));
              this.stats.prunedParts++;
              counts.error++;
            }

            msgModified = true;
            return { ...part, input: prunedInput };
          });

          if (msgModified) {
            messages[i] = { ...asstMsg, content: newContent as unknown as ContextAssistantMessage['content'] };
            changed = true;
          }
        }
      }
    } // end purgeErrors

    // --- Phase 6: Inject prunable-tools context (skip in manual mode) ---
    if (!this.config.manualMode) {
      const prunableContext = this.buildPrunableToolsContext(messages, toolCalls);
      if (prunableContext) {
        // Find the last user message and append the prunable-tools context
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') {
            const userMsg = messages[i] as ContextMessage & { role: 'user'; content: string };
            messages[i] = { ...userMsg, content: userMsg.content + '\n\n' + prunableContext };
            changed = true;
            break;
          }
        }
      }
    } // end prunable-tools injection

    // --- Feedback ---
    if (changed) {
      const total = counts.duplicate + counts.supersede + counts.error + counts.manual + counts.distill;
      const newlyPruned = this.seenToolCallIds.size - seenSizeBefore;
      if (total > 0 && newlyPruned > 0) {
        const parts: string[] = [];
        if (counts.duplicate) parts.push(`${counts.duplicate} duplicate`);
        if (counts.supersede) parts.push(`${counts.supersede} supersede`);
        if (counts.error) parts.push(`${counts.error} error-input`);
        if (counts.manual) parts.push(`${counts.manual} manual`);
        if (counts.distill) parts.push(`${counts.distill} distill`);

        const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        const summary = `🧹 DCP: Pruned ${total} output(s)${detail} — ±${this.stats.estimatedTokensSaved} tokens saved total`;

        context.log(summary, 'info');
        const taskContext = context.getTaskContext();
        if (taskContext) taskContext.addLogMessage('info', summary);
      }

      return { optimizedMessages: messages };
    }

    return undefined;
  }

  // --- Tools ---

  getTools(_context: ExtensionContext, _mode: string, _agentProfile: AgentProfile): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    if (this.config.enabled && this.config.tools.prune) {
      tools.push({
        name: 'dcp-prune',
        description:
          'Mark specific tool messages for pruning. Their outputs will be replaced with a placeholder before the next LLM request. Use this to remove obsolete or noisy tool outputs from conversation history.',
        inputSchema: z.object({
          messageIds: z.array(z.string()).describe('IDs of tool messages to prune'),
          reason: z.string().optional().describe('Reason for pruning (shown in placeholder)')
        }),
        execute: async (input, _signal, extContext) => {
          const ids = (input.messageIds as string[]).filter(id => id && id !== 'undefined');
          if (ids.length === 0) {
            const msg = '🧹 DCP: No valid message IDs provided — nothing to prune';
            extContext.log(msg, 'warn');
            return msg;
          }
          ids.forEach(id => this.manuallyPrunedIds.add(id));
          const msg = `🧹 DCP: Marked ${ids.length} message(s) for pruning — will take effect on next request`;
          extContext.log(msg, 'info');
          const taskContext = extContext.getTaskContext();
          if (taskContext) taskContext.addLogMessage('info', msg);
          return msg;
        }
      });
    }

    if (this.config.enabled && this.config.tools.distill) {
      tools.push({
        name: 'dcp-distill',
        description:
          'Preserve a concise summary of key findings from a range of messages, then prune all tool outputs in that range. Call this after completing a research phase to reduce context while retaining insights.',
        inputSchema: z.object({
          summary: z.string().describe('Concise summary of the findings to preserve'),
          range: z
            .object({
              startId: z.string(),
              endId: z.string()
            })
            .describe('Inclusive range of message IDs whose tool outputs should be pruned')
        }),
        execute: async (input, _signal, extContext) => {
          const range = input.range as { startId: string; endId: string };
          this.distilledRanges.push({
            startId: range.startId,
            endId: range.endId,
            summary: input.summary as string
          });
          const msg = `🧹 DCP: Range distilled — tool outputs will be pruned on next request. Summary: "${input.summary}"`;
          extContext.log(msg, 'info');
          const taskContext = extContext.getTaskContext();
          if (taskContext) taskContext.addLogMessage('info', msg);
          return msg;
        }
      });
    }

    return tools;
  }

  // --- Commands ---

  getCommands(_context: ExtensionContext): CommandDefinition[] {
    return [
      {
        name: 'dcp',
        description: 'Manage Dynamic Context Pruning — subcommands: stats, sweep [count], reset',
        arguments: [{ description: 'Subcommand: stats | sweep [count] | reset', required: false }],
        execute: async (args, extContext) => {
          const sub = args[0];
          const taskContext = extContext.getTaskContext();

          if (sub === 'stats') {
            const msg =
              `🧹 DCP: Stats — ${this.stats.prunedParts} part(s) pruned total, ` +
              `±${this.stats.estimatedTokensSaved} tokens saved, ` +
              `${this.distilledRanges.length} active distillation range(s), ` +
              `${this.manuallyPrunedIds.size} message(s) marked for manual pruning`;
            extContext.log(msg, 'info');
            if (taskContext) taskContext.addLogMessage('info', msg);
          } else if (sub === 'sweep') {
            if (taskContext) {
              const count = args[1] ? parseInt(args[1], 10) : undefined;
              const messages = await taskContext.getContextMessages();
              let toolMessages = messages.filter(m => m.role === 'tool' && !this.manuallyPrunedIds.has(m.id));
              if (count && count > 0) {
                toolMessages = toolMessages.slice(-count);
              }
              toolMessages.forEach(m => this.manuallyPrunedIds.add(m.id));
              const countLabel = count && count > 0 ? ` (last ${count})` : '';
              const msg = `🧹 DCP Sweep: Marked ${toolMessages.length} tool message(s)${countLabel} for pruning — will take effect on next request`;
              extContext.log(msg, 'info');
              taskContext.addLogMessage('info', msg);
            } else {
              extContext.log('🧹 DCP Sweep: No active task', 'warn');
            }
          } else if (sub === 'reset') {
            this.stats = { prunedParts: 0, estimatedTokensSaved: 0 };
            this.seenToolCallIds.clear();
            this.manuallyPrunedIds.clear();
            this.distilledRanges = [];
            this.lastToolWasDcp = false;
            this.nudgeCounter = 0;
            const msg = '🧹 DCP: State reset — all stats, prune marks, and distillation ranges cleared';
            extContext.log(msg, 'info');
            if (taskContext) taskContext.addLogMessage('info', msg);
          } else if (!sub) {
            const msg = '🧹 DCP: commands — /dcp stats | /dcp sweep [count] | /dcp reset';
            extContext.log(msg, 'info');
            if (taskContext) taskContext.addLogMessage('info', msg);
          } else {
            const help = `🧹 DCP: Unknown subcommand "${sub}". Available: stats, sweep, reset`;
            extContext.log(help, 'warn');
            if (taskContext) taskContext.addLogMessage('warning', help);
          }
        }
      }
    ];
  }
}
