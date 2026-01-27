
A reusable template for devcontainers with claude
==================================================

This is adapted from the reference dev container setup from Anthropic:

https://github.com/anthropics/claude-code/tree/main/.devcontainer

It includes various adaptations because the dev environment needs to be suited
for the project, not just for Claude. Ideally this should be moved to Nix or
docker compose, or something with a composable abstraction for combining two
different sets of dependencies.

The goal here is to support:

- a somewhat-locked down environment for Claude --dangerously-skip-permissions
- remote/voice connections with happy-coder
- compilers/libs for a specific project
