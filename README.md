# 🚀 Awesome AiderDesk

A community-curated collection of extensions, agents, skills, and commands to supercharge your [AiderDesk](https://aiderdesk.hotovo.com) experience.

> [!TIP]
> **AiderDesk** is an AI-powered coding assistant that helps you write, review, and refactor code. Visit [aiderdesk.hotovo.com](https://aiderdesk.hotovo.com) to learn more and get started.

## What's in this repo

| Resource | Description |
|----------|-------------|
| 🔌 [Extensions](extensions/) | TypeScript-based extensions that extend AiderDesk's functionality |
| 🤖 [Agents](#) *(coming soon)* | Specialized agents for specific tasks |
| 🎯 [Skills](#) *(coming soon)* | Self-contained capabilities and tools |
| ⌨️ [Commands](#) *(coming soon)* | Custom commands for common workflows |

## 🔌 Extensions

This repository hosts community-contributed extensions for AiderDesk. Extensions are TypeScript-based plugins that can:

- Add new tools and commands
- Integrate with external APIs and services
- Customize the UI and user experience
- Implement custom workflows and automation
- Provide language-specific assistance

### Installation

#### Using the CLI (Recommended)

The easiest way to install extensions from this repository is using the AiderDesk CLI with GitHub URLs:

```bash
# Install from this repository - Global (available in all projects)
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/path-instructions --global

# Install from this repository - Local (project-specific)
npx @aiderdesk/extensions install https://github.com/klocus/awesome-aider-desk/tree/main/extensions/path-instructions
```

#### Adding to AiderDesk Settings (Best for frequent use)

To make extensions from this repository available in the AiderDesk UI, add it as a custom extension catalog:

1. Open AiderDesk Settings
2. Go to **Extensions** section
3. Add this repository URL to the extension catalogs:
   ```
   https://github.com/klocus/awesome-aider-desk/tree/main/extensions
   ```

After adding, you can browse and install all extensions from this repository directly in the AiderDesk interface, alongside the official extensions.

## Contributing

Contributions are welcome! Whether you've created an extension, improved documentation, or found a bug, we'd love to hear from you.

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

## Official Extensions

For reference, see the official extensions maintained by the AiderDesk team:
- [@aiderdesk/extensions](https://github.com/hotovo/aider-desk/tree/main/packages/extensions) - Official extension examples and templates

## 📚 Additional Resources

- [AiderDesk Website](https://aiderdesk.hotovo.com) - Official website and documentation
- [AiderDesk GitHub](https://github.com/hotovo/aider-desk) - Official repository
- [Extension Documentation](https://aiderdesk.hotovo.com/docs/extensions/) - Comprehensive extension guide

## 🏢 About AiderDesk

AiderDesk is developed and maintained by [Hotovo](https://www.hotovo.com). It's a powerful AI coding assistant that helps developers write better code, faster.

## 📝 License

This repository is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ℹ️ Disclaimer

The extensions in this repository are community-contributed and not officially maintained or endorsed by Hotovo. Please review each extension's code and documentation before installing.

---

Made with ❤️ by the AiderDesk community
