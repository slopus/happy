# Multi-stage Docker container for automated code fixing
# Stage 1: Base with Node.js and system dependencies
FROM node:20-alpine AS base

# Install system dependencies
RUN apk add --no-cache \
    git \
    curl \
    bash \
    python3 \
    py3-pip \
    openjdk11-jre \
    docker-cli \
    build-base \
    linux-headers

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Stage 2: Setup MCP servers and tools
FROM base AS tools

WORKDIR /app

# Copy package.json for dependencies
COPY package.json ./
RUN npm install

# Install global tools
RUN npm install -g \
    @biomejs/biome \
    eslint \
    typescript \
    expo-cli \
    @expo/cli \
    exa-mcp-server

# Stage 3: Final container
FROM tools AS final

# Set environment variables
ENV NODE_ENV=production
ENV CLAUDE_API_KEY=85c99bec0fa64a0d8a4a01463868667a.RsDzW0iuxtgvYqd2
ENV EXA_API_KEY=b65999c0-db14-4241-9a53-f58b4656ae4b
ENV SONAR_HOST_URL=http://localhost:9000

# Create app directory
WORKDIR /app

# Copy application files
COPY . .

# Create claude config directory
RUN mkdir -p /root/.config/claude

# Copy Claude MCP configuration
COPY claude_config.json /root/.config/claude/claude_desktop_config.json

# Copy scripts
COPY scripts/ ./scripts/
RUN chmod +x ./scripts/*.sh

# Create workspace for repo cloning
RUN mkdir -p /workspace

# Install dependencies
RUN npm install --production

# Expose ports
EXPOSE 3000 9000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "src/server.js"]