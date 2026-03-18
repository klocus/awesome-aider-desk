# 🔌 Extensions

This repository hosts community-contributed extensions for AiderDesk. Extensions are TypeScript-based plugins that can:

- Add new tools and commands
- Integrate with external APIs and services
- Customize the UI and user experience
- Implement custom workflows and automation
- Provide language-specific assistance

## Installation

### Using the CLI (Recommended)

The easiest way to install extensions from this repository is using the AiderDesk CLI with GitHub URLs:

```bash
# Install from this repository - Global (available in all projects)
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/path-instructions --global

# Install from this repository - Local (project-specific)
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/path-instructions
```

### Adding to AiderDesk Settings (Best for frequent use)

To make extensions from this repository available in the AiderDesk UI, add it as a custom extension catalog:

1. Open AiderDesk Settings
2. Go to **Extensions** section
3. Add this repository URL to the extension catalogs:
   ```
   https://github.com/klocus/awesome-aider-desk/tree/main/extensions
   ```

After adding, you can browse and install all extensions from this repository directly in the AiderDesk interface, alongside the official extensions.

## Contributing

### Adding an Extension

To add your extension to this repository:

1. Fork this repository
2. Create a new directory in `extensions/` with your extension name
3. Add your extension files and a `README.md` with usage instructions
4. Submit a pull request

### Extension Guidelines

- Follow the [official AiderDesk extension development guide](https://aiderdesk.hotovo.com/docs/extensions/creating-extensions)
- Provide clear documentation and usage examples
- Test your extension thoroughly
- Include type definitions for TypeScript support
- Consider edge cases and error handling
