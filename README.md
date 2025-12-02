# Happy Self-Hosted

A fork of [Happy](https://github.com/slopus/happy) configured for self-hosting. This repo combines the server, CLI, and webapp as git submodules with scripts for local development.

## What is Happy?

Happy is a remote control system for Claude Code. It lets you monitor and interact with Claude sessions running on your development machines from a web or mobile app.

## Repository Structure

```
happy/           # React Native webapp (Expo)
happy-cli/       # CLI tool that wraps Claude Code
happy-server/    # Node.js API server
```

## Getting Started

- **[QUICKSTART.md](QUICKSTART.md)** - Self-hosting setup guide
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Developer guide for working on this repo

## Quick Links

| Component | Port | URL |
|-----------|------|-----|
| Webapp | 8081 | http://localhost:8081 |
| Server | 3005 | http://localhost:3005 |
| MinIO Console | 9001 | http://localhost:9001 |
