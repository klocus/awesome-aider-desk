# Path-Specific Instructions Extension for AiderDesk

Mirror of [GitHub Copilot's path-specific custom instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions#creating-path-specific-custom-instructions-1) feature. This extension allows you to define coding rules that are only applied when working with specific files or directories.

## What it does?

The extension automatically injects context-specific coding standards into the AI agent's instructions based on the files currently being edited or added to the context. It scans your project for `./.aider-desk/instructions/*.instructions.md` files, parses their rules, and ensures they are active only for the files specified in their configuration.

## Features

- **Context-Aware Injection**: Instructions are loaded only when you start working on matching files, keeping the AI's context window clean.
- **Glob Pattern Support**: Full support for standard glob patterns to target specific directories or file types:
  - `*` for files in the current directory.
  - `**/*.ts` for recursive matching of all TypeScript files.
  - `src/**/*` for everything inside the `src` folder.
  - `{a,b}` for multiple alternatives.
- **YAML Frontmatter**: Easy configuration using standard YAML metadata at the top of instruction files.
- **Automatic Discovery**: Scans `.github/instructions/` and `.aider-desk/instructions/` directories automatically.

## Installation

**Global** (available in all projects)

```bash
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/path-instructions --global
```

**Local** (project-level)

```bash
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/path-instructions
```

## How to use it?

1.  **Create an instructions directory**: Create `.aider-desk/instructions/` in your project root.
2.  **Add instruction files**: Create Markdown files ending in `.instructions.md` (e.g., `angular.instructions.md`).
3.  **Define patterns and rules**: Add YAML frontmatter at the top to specify which files the rules apply to, followed by your instructions:

```markdown
---
applyTo: "src/app/**/*.ts, src/app/**/*.html"
---

- Use OnPush change detection strategy for all new components.
- Prefer signals over observables for local state.
- Ensure all components have associated unit tests.
```

The extension will handle the rest, notifying you via the logs whenever path-specific instructions are applied to your current task.
