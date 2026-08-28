# Agent Testing Layers

Keep this simple.

## Layer 1

Layer 1 is direct integration with the real agent.

Source of truth:

- `packages/happy-cli/agents.md`

## Layer 2

Layer 2 is full Happy product validation.

Source of truth:

- `./product.md`

## Paws Agent SDK and CLI

`paws-agent` uses three automated gates:

- unit tests for typed resources, encryption compatibility, errors, and CLI delegation;
- packed-artifact tests for ESM, CJS, declarations, CLI, browser bundling, and Chromium;
- an isolated full-stack suite with a temporary Paws Server, daemon, credentials, and deterministic `ask` sessions.

The isolated suite starts the environment with `--no-web` and routes the fixture model endpoint to localhost, so it covers authentication, machine/session RPC, idempotent messages, history, reconnect, directory approval, archive, and stable error codes without vendor access or model cost.

Source of truth:

- `packages/paws-agent/src/paws-agent.integration.test.ts`
- `packages/paws-agent/scripts/verify-pack.mjs`
- `docs/superpowers/specs/2026-08-28-paws-agent-sdk-design.md`
