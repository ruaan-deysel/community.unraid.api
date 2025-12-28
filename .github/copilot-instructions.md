# GitHub Copilot Instructions for Unraid Codebase

## Overview
This document provides guidance for AI coding agents working with the Unraid codebase. The project is designed to monitor and control Unraid servers, utilizing the Homey platform for app development.

## Architecture
- **Main Component**: The core application is defined in `app.ts`, which extends the `Homey.App` class. The `onInit` method is crucial for initializing the app.
- **Development Environment**: The project uses a VS Code Dev Container, ensuring a consistent development setup with Node.js and Homey CLI.
- **Scripts**: The `scripts/setup.sh` file automates the setup of the development environment, including the installation of necessary tools like Homey CLI and Claude Code.

## Developer Workflows
- **Building the Project**: Use the command `npm run build` to compile TypeScript files.
- **Linting**: Run `npm run lint` to check for code quality issues using ESLint. **Zero tolerance for linting errors and warnings** — all linting issues must be fixed before any code is committed.
- **Testing**: Ensure to write tests for new features, following the conventions established in the project.

## Code Quality Standards
- **Homey Developer Best Practices**: All development must strictly follow Homey developer best practices. This includes proper module structure, async/await patterns, and Homey API usage conventions.
- **Linting Requirements**: Every code change must pass ESLint without errors or warnings. Run `npm run lint` after each modification and fix all issues immediately.
- **Development Environment**: All development must be done within the dev container. Never work outside the containerized environment to ensure consistency and proper tool availability.

## Project Conventions
- **File Structure**: Follow the existing file structure for adding new components. Place new scripts in the `scripts/` directory and maintain naming conventions.
- **Logging**: Use the `this.log()` method for logging within the app, as seen in `app.ts`.

## Integration Points
- **Homey CLI**: The project relies on the Homey CLI for app management. Ensure it is installed globally as part of the setup process.
- **External Dependencies**: The project uses several devDependencies, including TypeScript and ESLint, which should be kept up to date.

## Examples
- **Initialization**: The `onInit` method in `app.ts` is a key entry point for the app's logic. Ensure to implement any necessary setup within this method.
- **Setup Script**: The `setup.sh` script is an example of automating environment setup. Follow its structure for any additional setup scripts needed in the future.

## Conclusion
This document should serve as a foundational guide for AI coding agents to effectively contribute to the Unraid codebase. For any unclear sections, please provide feedback for further refinement.