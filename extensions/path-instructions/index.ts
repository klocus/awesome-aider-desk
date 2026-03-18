/**
 * Path-Specific Custom Instructions Extension
 *
 * Mirrors GitHub Copilot's path-specific custom instructions feature:
 * https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions#creating-path-specific-custom-instructions-1
 *
 * Reads `*.instructions.md` files, parses their `applyTo` glob frontmatter,
 * and injects matching instructions the first time a file matching those patterns
 * is about to be written or edited in the current task.
 *
 * Two injection points:
 * - onAgentStarted: injects instructions into customInstructions based on
 *   existing context files (before the agent runs).
 * - onToolCalled: non-blocking observer that injects instructions as a context
 *   message when a file write/edit targets a new matching pattern.
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  AgentStartedEvent,
  Extension,
  ExtensionContext,
  TaskClosedEvent,
  ToolCalledEvent
} from '@aiderdesk/extensions';

export const metadata = {
  name: 'Path-Specific Instructions',
  version: '1.0.0',
  description: 'Injects *.instructions.md before the first write/edit of matching files',
  author: 'Paweł Klockiewicz',
  capabilities: ['events']
};

interface InstructionFile {
  applyTo: string[];
  content: string;
  filePath: string;
}

const FILE_WRITE_TOOLS = new Set(['file_write', 'power---file_write', 'file_edit', 'power---file_edit']);

class PathInstructionsExtension implements Extension {
  /** Tracks which instruction files have already been injected, keyed by task ID. */
  private readonly appliedPerTask = new Map<string, Set<string>>();

  async onAgentStarted(
    event: AgentStartedEvent,
    context: ExtensionContext
  ): Promise<void | Partial<AgentStartedEvent>> {
    const projectDir = context.getProjectDir();
    const instructionFiles = this.loadAllInstructionFiles(projectDir);
    if (instructionFiles.length === 0) {
      return;
    }

    const contextFilePaths = event.contextFiles.map(f => (f as { path: string }).path);
    if (contextFilePaths.length === 0) {
      return;
    }

    const taskContext = context.getTaskContext();
    const taskId = taskContext?.data?.id ?? '__default__';

    const newInstructions = this.collectNew(instructionFiles, taskId, instr =>
      contextFilePaths.some(fp => instr.applyTo.some(p => this.matchGlob(p.trim(), fp)))
    );
    if (newInstructions.length === 0) {
      return;
    }

    const names = newInstructions.map(f => path.basename(f.filePath, '.instructions.md'));
    taskContext?.addLogMessage('info', `📋 Path instructions applied: ${names.map(n => `\`${n}\``).join(', ')}`);

    const injected = newInstructions.map(f => this.formatInstructions(f)).join('\n\n');
    const existing = event.agentProfile?.customInstructions ?? '';
    const separator = existing.trim() ? '\n\n' : '';

    return {
      agentProfile: {
        ...event.agentProfile,
        customInstructions: existing + separator + injected
      }
    };
  }

  async onToolCalled(event: ToolCalledEvent, context: ExtensionContext): Promise<void> {
    if (!FILE_WRITE_TOOLS.has(event.toolName) || !event.input) {
      return;
    }

    const filePath = (event.input.filePath ?? event.input.path) as string | undefined;
    if (!filePath) {
      return;
    }

    const projectDir = context.getProjectDir();
    const instructionFiles = this.loadAllInstructionFiles(projectDir);
    if (instructionFiles.length === 0) {
      return;
    }

    const taskContext = context.getTaskContext();
    const taskId = taskContext?.data?.id ?? '__default__';

    const newInstructions = this.collectNew(instructionFiles, taskId, instr =>
      instr.applyTo.some(pattern => this.matchGlob(pattern.trim(), filePath))
    );

    if (newInstructions.length === 0) {
      return;
    }

    const names = newInstructions.map(f => path.basename(f.filePath, '.instructions.md'));
    taskContext?.addLogMessage('info', `📋 Path instructions applied: ${names.map(n => `\`${n}\``).join(', ')}`);

    const instructionsText = newInstructions.map(f => this.formatInstructions(f)).join('\n\n');

    await taskContext?.addContextMessage({
      id: `path-instructions-${Date.now()}`,
      role: 'user',
      content: `Path-specific coding instructions have been loaded for files matching the patterns below. Follow these instructions for all current and future file operations:\n\n${instructionsText}`
    });
  }

  async onTaskClosed(event: TaskClosedEvent): Promise<void> {
    this.appliedPerTask.delete(event.task.id);
  }

  /**
   * Returns instruction files that match the predicate AND have not yet been
   * applied for this task. Marks them as applied before returning.
   */
  private collectNew(
    instructionFiles: InstructionFile[],
    taskId: string,
    predicate: (instr: InstructionFile) => boolean
  ): InstructionFile[] {
    if (!this.appliedPerTask.has(taskId)) {
      this.appliedPerTask.set(taskId, new Set());
    }
    const applied = this.appliedPerTask.get(taskId)!;

    const matched = instructionFiles.filter(instr => !applied.has(instr.filePath) && predicate(instr));
    for (const instr of matched) {
      applied.add(instr.filePath);
    }
    return matched;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  private formatInstructions(instr: InstructionFile): string {
    const applyTo = instr.applyTo.join(', ');
    return `<instructions applyTo="${applyTo}">\n${instr.content}\n</instructions>`;
  }

  // ---------------------------------------------------------------------------
  // Instruction file loading
  // ---------------------------------------------------------------------------

  private loadAllInstructionFiles(projectDir: string): InstructionFile[] {
    const candidateDirs = [
      path.join(projectDir, '.github', 'instructions'),
      path.join(projectDir, '.aider-desk', 'instructions')
    ];

    return candidateDirs.filter(dir => fs.existsSync(dir)).flatMap(dir => this.loadInstructionFiles(dir));
  }

  private loadInstructionFiles(dir: string): InstructionFile[] {
    const results: InstructionFile[] = [];

    const walk = (currentDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.instructions.md')) {
          const parsed = this.parseInstructionFile(fullPath);
          if (parsed) {
            results.push(parsed);
          }
        }
      }
    };

    walk(dir);
    return results;
  }

  private parseInstructionFile(filePath: string): InstructionFile | null {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatter = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();

    if (!body) {
      return null;
    }

    const applyTo = this.parseApplyTo(frontmatter);
    if (applyTo.length === 0) {
      return null;
    }

    return { applyTo, content: body, filePath };
  }

  /**
   * Parses `applyTo` from YAML frontmatter. Supports quoted/unquoted values
   * and comma-separated glob patterns.
   *
   * Examples:
   *   applyTo: "**\/*.ts,**\/*.tsx"
   *   applyTo: src/**
   */
  private parseApplyTo(frontmatter: string): string[] {
    const match = frontmatter.match(/^applyTo\s*:\s*(.+)$/m);
    if (!match) {
      return [];
    }

    let value = match[1].trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    return value
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Glob matching
  // ---------------------------------------------------------------------------

  private matchGlob(pattern: string, filePath: string): boolean {
    const normPath = filePath.replace(/\\/g, '/');
    const normPattern = pattern.replace(/\\/g, '/');
    return this.globToRegex(normPattern).test(normPath);
  }

  private globToRegex(pattern: string): RegExp {
    let regexStr = '';
    let i = 0;

    while (i < pattern.length) {
      const ch = pattern[i];

      if (ch === '*' && pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else if (ch === '*') {
        regexStr += '[^/]*';
        i++;
      } else if (ch === '?') {
        regexStr += '[^/]';
        i++;
      } else if (ch === '{') {
        const close = pattern.indexOf('}', i);
        if (close === -1) {
          regexStr += '\\{';
          i++;
        } else {
          const options = pattern
            .slice(i + 1, close)
            .split(',')
            .map(o => this.escapeRegex(o))
            .join('|');
          regexStr += `(?:${options})`;
          i = close + 1;
        }
      } else if (ch === '[') {
        const close = pattern.indexOf(']', i);
        if (close === -1) {
          regexStr += '\\[';
          i++;
        } else {
          regexStr += pattern.slice(i, close + 1);
          i = close + 1;
        }
      } else if ('.+^$|\\()'.includes(ch)) {
        regexStr += '\\' + ch;
        i++;
      } else {
        regexStr += ch;
        i++;
      }
    }

    return new RegExp(`^${regexStr}$`);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
}

export default PathInstructionsExtension;
