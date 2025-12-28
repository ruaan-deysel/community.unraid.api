#!/bin/bash
set -euo pipefail

echo "🚀 Setting up Homey Unraid development environment..."

echo "🔧 Ensuring Node/npm are available..."
node --version
npm --version

# Install Homey CLI & Claude Code globally
echo "🏠 Installing Homey CLI & 🧠 Claude Code..."
npm install -g --no-optional homey @anthropic-ai/claude-code
homey --version || true
claude --version || true

# Optional: install pnpm if present or requested
if ! command -v pnpm >/dev/null 2>&1; then
  echo "📦 Installing pnpm..."
  npm install -g pnpm
fi

# Install project dependencies if package.json exists
if [ -f "package.json" ]; then
  echo "📦 Installing project dependencies..."
  pnpm install
fi

# Install GitHub Copilot CLI extension
echo "🤖 Installing GitHub Copilot CLI..."
gh extension install github/gh-copilot || echo "⚠️ Copilot CLI already installed or failed"

# Install Claude Code
echo "🔑 Configuring environment (Claude Code)"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "✅ ANTHROPIC_API_KEY detected in environment."
else
  echo "⚠️ ANTHROPIC_API_KEY not set. Set it locally to pass-through (containerEnv)."
fi

# Install Playwright browsers for E2E testing
if [ -f "playwright.config.ts" ] || [ -f "playwright.config.js" ]; then
  echo "🎭 Installing Playwright browsers..."
  npx playwright install --with-deps chromium || true
fi

# Verify installations
echo ""
echo "✅ Verifying installations..."
echo "  Node: $(node --version)"
echo "  pnpm: $(pnpm --version)"
echo "  gh: $(gh --version | head -1)"
gh copilot --version 2>/dev/null && echo "  gh copilot: installed" || echo "  gh copilot: run 'gh auth login' first"
claude --version 2>/dev/null && echo "  claude: $(claude --version)" || echo "  claude: installed (run 'claude' to authenticate)"
homey --version 2>/dev/null && echo "  homey: $(homey --version)" || echo "  homey: installed"

echo ""
echo "🎉 Development environment ready!"
echo ""
echo "Next steps:"
echo "  1. Run 'gh auth login' to authenticate GitHub CLI"
echo "  2. Set ANTHROPIC_API_KEY and run 'claude' to authenticate Claude Code"
echo "  3. If you scaffolded a Homey app, run 'homey app run'"
echo "  4. Copy .env.local.example to .env.local and add your keys (if applicable)"
echo "  5. Run 'pnpm dev' to start any web server (if applicable)"