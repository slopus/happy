# Agent Catalog - CLI

This doc explains how the **Agent Catalog** works in Happy, and how to add a new agent/backend without guessing.

---

## Terms (what each thing means)

- **AgentId**: the canonical id for an agent, shared across CLI + Expo (+ server).
  - Source of truth: `@happy/agents` (`packages/agents`).
- **Agent Catalog (CLI)**: the declarative mapping of `AgentId -> integration hooks` used to drive:
  - CLI command routing
  - capability detection/checklists
  - daemon spawn wiring
  - optional ACP backend factories
  - Source: `cli/src/backends/catalog.ts`
- **Backend folder**: provider/agent-specific code and wiring.
  - Source: `cli/src/backends/<agentId>/**`
- **Protocol**: shared cross-boundary contracts between UI and CLI daemon.
  - Source: `@happy/protocol` (`packages/protocol`).

---

## Sources of truth

### 1) Shared core manifest: `@happy/agents`

Where: `packages/agents/src/manifest.ts`

What belongs here:
- canonical ids (`AgentId`)
- identity/aliases for parsing or migration (e.g. `flavorAliases`)
- resume core capabilities (e.g. `resume.runtimeGate`, `resume.vendorResume`)
- cloud connect core mapping (if any): `cloudConnect`

What does **not** belong here:
- UI assets (icons/images)
- UI routes
- CLI implementation details (argv, env, paths)

### 2) Cross-boundary contracts: `@happy/protocol`

Where: `packages/protocol/src/*`

What belongs here:
- daemon RPC result shapes that the Expo app needs to interpret deterministically
- stable error codes (e.g. spawn/resume failures)

Example:
- `packages/protocol/src/spawnSession.ts` defines `SpawnSessionErrorCode` + `SpawnSessionResult`.

### 3) CLI agent catalog: `cli/src/backends/catalog.ts`

Where the CLI assembles all backends into a single map:
- `export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = { ... }`
- helper resolvers like `resolveCatalogAgentId(...)`

---

## CLI backend layout (recommended)

Each backend folder exports one canonical entry object from its `index.ts`:

- `cli/src/backends/<agentId>/index.ts` exports:
  - `export const agent = { ... } satisfies AgentCatalogEntry;`

The global catalog imports those entries and assembles them:
- `cli/src/backends/catalog.ts`

This keeps backend-specific wiring co-located, while preserving a deterministic, explicit catalog (no self-registration side effects).

---

## AgentCatalogEntry hooks (CLI)

Type: `cli/src/backends/types.ts` (`AgentCatalogEntry`)

### Required

- `id: AgentId`
- `cliSubcommand: AgentId`
- `vendorResumeSupport: VendorResumeSupportLevel` (from `@happy/agents`)

### Optional hooks (what they do)

- `getCliCommandHandler(): Promise<CommandHandler>`
  - Provides the `happy <agentId> ...` CLI subcommand handler.
  - Used by `cli/src/cli/commandRegistry.ts`.

- `getCliCapabilityOverride(): Promise<Capability>`
  - Defines the `cli.<agentId>` capability descriptor, if the generic one is not sufficient.

- `getCapabilities(): Promise<Capability[]>`
  - Adds extra capabilities beyond `cli.<agentId>`, typically:
    - `dep.${string}` (dependency checks)
    - `tool.${string}` (tool availability)
  - Example: Codex contributes `dep.codex-acp` etc.

- `getCliDetect(): Promise<CliDetectSpec>`
  - Provides version/login-status probe argv patterns used by the CLI snapshot.
  - Consumed by `cli/src/capabilities/snapshots/cliSnapshot.ts`.

- `getCloudConnectTarget(): Promise<CloudConnectTarget>`
  - Enables `happy connect <agentId>` for this agent.
  - The preferred source-of-truth for connect availability + vendor mapping is `@happy/agents` (and this hook returns the implementation object).

- `getDaemonSpawnHooks(): Promise<DaemonSpawnHooks>`
  - Allows per-agent spawn customizations in the daemon, while keeping the wiring co-located with the backend.

- `getHeadlessTmuxArgvTransform(): Promise<(argv: string[]) => string[]>`
  - Optional argv rewrite for `--tmux` / headless launching.

- `getAcpBackendFactory(): Promise<(opts: unknown) => { backend: AgentBackend }>`
  - Provides an ACP backend factory for agents that run via ACP.

- `checklists?: AgentChecklistContributions`
  - Optional additions to the capability checklists system.
  - Prefer data-only contributions (no side-effect registration).

---

## Capabilities + checklists contract (CLI ↔ Expo)

### Capability id conventions (CLI)

Defined in `cli/src/capabilities/types.ts`:
- `cli.<agentId>`: base “agent detected + login status + (optional) ACP capability surface” probe
- `tool.${string}`: tool capability (e.g. `tool.tmux`)
- `dep.${string}`: dependency capability (e.g. `dep.codex-acp`)

### Checklist id conventions (CLI)

Checklist ids are strings; we treat these as stable API between daemon and UI:
- `new-session`
- `machine-details`
- `resume.<agentId>` (one per agent)

### ACP resume runtime gate

Some agents don’t have “vendor resume” universally enabled, but can be resumable depending on whether ACP `loadSession` is supported on the machine.

In `@happy/agents`, this is represented as:
- `resume.runtimeGate === 'acpLoadSession'`

In the CLI, this is implemented by making `resume.<agentId>` checklists include an agent probe request that sets `includeAcpCapabilities: true`.

So UI logic can treat “ACP resume supported” as:
- the daemon’s `resume.<agentId>` checklist result contains a `cli.<agentId>` capability whose `acpCapabilities.loadSession` indicates support (shape defined by the CLI capability implementation).

---

## Adding a new agent/backend (CLI)

### Step 0 — Pick the id contract

Decide a new canonical id (example): `myagent`.

We strongly prefer:
- `AgentId === CLI subcommand === detectKey`

### Step 1 — Add the agent to `@happy/agents`

Edit:
- `packages/agents/src/manifest.ts`

Add:
- `AgentId` entry
- any `flavorAliases`
- `resume.vendorResume` (`supported|unsupported|experimental`)
- optional `resume.runtimeGate` (e.g. `'acpLoadSession'`)
- optional `cloudConnect` mapping if it participates in cloud connect UX

### Step 2 — Create a backend folder in the CLI

Create folder:
- `cli/src/backends/myagent/`

Add whatever you need (examples):
- `cli/command.ts` (subcommand handler)
- `cli/capability.ts` (optional override for `cli.myagent`)
- `cli/detect.ts` (version/login probe spec)
- `daemon/spawnHooks.ts` (if needed)
- `acp/backend.ts` (if it’s an ACP backend)
- `cloud/connect.ts` (if it supports connect)

### Step 3 — Export the catalog entry from `index.ts`

Create:
- `cli/src/backends/myagent/index.ts`

Pattern:
```ts
import { AGENTS_CORE } from '@happy/agents';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.myagent.id,
  cliSubcommand: AGENTS_CORE.myagent.cliSubcommand,
  vendorResumeSupport: AGENTS_CORE.myagent.resume.vendorResume,
  getCliCommandHandler: async () => (await import('./cli/command')).handleMyAgentCliCommand,
  getCliDetect: async () => (await import('./cli/detect')).cliDetect,
  // other hooks as needed...
} satisfies AgentCatalogEntry;
```

### Step 4 — Add it to the catalog assembly

Edit:
- `cli/src/backends/catalog.ts`

Add:
```ts
import { agent as myagent } from '@/backends/myagent';

export const AGENTS = {
  // ...
  myagent,
} satisfies Record<CatalogAgentId, AgentCatalogEntry>;
```

### Step 5 — Verify

Run:
```bash
yarn --cwd cli typecheck
yarn --cwd cli test
```

---

## What not to do (anti-patterns)

- Don’t “auto-discover” backends by scanning the filesystem. We want deterministic bundling and explicit reviewable changes.
- Don’t do side-effect self-registration (“import this file and it registers itself”). It makes ordering brittle and behavior hard to audit.
- Don’t leave long-lived “stubs” (re-export shims) as an architectural layer. Prefer canonical entrypoints and direct imports.


