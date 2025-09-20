#!/bin/bash

# Setup MCP servers for Claude Code in Docker container

set -e

echo "Setting up MCP servers..."

# Install Claude Code globally if not already installed
if ! command -v claude &> /dev/null; then
    echo "Installing Claude Code..."
    npm install -g @anthropic-ai/claude-code
fi

# Setup MCP servers
echo "Setting up Exa Search MCP..."
claude mcp add exa -e EXA_API_KEY=${EXA_API_KEY} -- npx -y exa-mcp-server

echo "Setting up GitHub MCP..."
if [ ! -z "$GITHUB_TOKEN" ]; then
    claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_TOKEN} -- npx -y @modelcontextprotocol/server-github
fi

echo "Setting up Filesystem MCP..."
claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /workspace

echo "Setting up Sequential Thinking MCP..."
claude mcp add sequential-thinking -- npx -y @modelcontextprotocol/server-sequential-thinking

# Verify MCP servers
echo "Verifying MCP servers..."
claude mcp list

echo "MCP setup completed successfully!"