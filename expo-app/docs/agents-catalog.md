# Expo agents/providers guide (Happy)

This doc explains how to add a new “agent/provider” to the **Expo app** in a way that stays:
- catalogue-driven (no hardcoded `if (agentId === ...)` in screens),
- capability-driven (runtime checks come from capability results),
- test-friendly (Node-side tests can import `@/agents/catalog` without loading native assets).

Last updated: 2026-01-27

---

## Mental model

There are 3 layers in Expo:

1) **Core registry** (`expo-app/sources/agents/registryCore.ts`)
   - Defines the agent’s identity, CLI wiring (detectKey/spawnAgent), resume configuration, permission prompt protocol, i18n keys, etc.
   - This is the source of truth for UI decision-making (e.g. “is agent experimental?”, “what resume mechanism is used?”).

2) **UI registry** (`expo-app/sources/agents/registryUi.ts`)
   - Expo-only visuals (icons, tints, glyphs, avatar sizing).
   - Loaded lazily by `expo-app/sources/agents/catalog.ts` to keep Node-side tests working.

3) **Behavior registry** (`expo-app/sources/agents/registryUiBehavior.ts`)
   - Provider-specific hooks for:
     - experimental resume switches,
     - runtime resume gating/prefetch,
     - preflight checks/prefetch,
     - spawn/resume payload extras,
     - new-session UI chips + new-session options,
     - spawn environment variable transforms.

Screens should import only from:
- `expo-app/sources/agents/catalog.ts` (single public surface)

Provider code lives under:
- `expo-app/sources/agents/providers/<agentId>/...`

---

## Files you typically add for a new agent

Create a provider folder:
- `expo-app/sources/agents/providers/<agentId>/core.ts`
- `expo-app/sources/agents/providers/<agentId>/ui.ts`
- `expo-app/sources/agents/providers/<agentId>/uiBehavior.ts` (optional)

Then wire them:
- Add `*_CORE` to `expo-app/sources/agents/registryCore.ts`
- Add `*_UI` to `expo-app/sources/agents/registryUi.ts`
- Add `*_UI_BEHAVIOR_OVERRIDE` to `expo-app/sources/agents/registryUiBehavior.ts` (only if you have overrides)

---

## Agent IDs (shared vs Expo)

The canonical IDs live in `@happy/agents` (workspace package). Expo imports `AGENT_IDS` and `AgentId` from there.

When adding a brand-new agent ID, update **both**:
- `packages/agents` (for canonical ids/types)
- Expo provider folder + registries

---

## Gating an agent behind experiments (agent selection)

To hide an agent unless experiments are enabled:
- Set `availability.experimental: true` in your provider `core.ts`.

This plugs into:
- `expo-app/sources/agents/enabled.ts`
  - gated by `settings.experiments === true` and `settings.experimentalAgents[agentId] === true`

The Settings screen uses `getAgentCore(agentId).availability.experimental` to list per-agent toggles.

---

## Resume configuration (core)

Resume is configured in `AgentCoreConfig.resume`:
- `supportsVendorResume: true | false`
- `experimental: true | false` (vendor resume requires opt-in)
- `runtimeGate: 'acpLoadSession' | null` (runtime-probed resume support when `supportsVendorResume === false`)
- `vendorResumeIdField` + `uiVendorResumeIdLabelKey` (for session-info “copy vendor id” UI)

### Common patterns

1) **Native vendor resume (stable)**
- `supportsVendorResume: true`
- `experimental: false`
- `runtimeGate: null`

2) **Native vendor resume (experimental)**
- `supportsVendorResume: true`
- `experimental: true`
- Provide the experiment switches + gating in `uiBehavior.ts` (see below).

3) **ACP runtime-gated resume (no vendor resume by default)**
- `supportsVendorResume: false`
- `runtimeGate: 'acpLoadSession'`
  - Default behavior in `registryUiBehavior.ts` will:
    - prefetch `cli.<detectKey>` with `includeAcpCapabilities`,
    - gate resumability on `acp.loadSession === true`.

---

## Provider behavior hooks (where “tricks” live)

All hooks are typed on `AgentUiBehavior` in `expo-app/sources/agents/registryUiBehavior.ts`.

### 1) Experimental resume switches (provider-owned)

Use when `core.resume.experimental === true` or you have multiple experiment paths.

Hooks:
- `resume.experimentSwitches`
  - provider declares which `Settings` keys are relevant
- `resume.getAllowExperimentalVendorResume({ experiments })`
  - provider decides whether experimental resume is enabled for *this agent*
- `resume.getExperimentalVendorResumeRequiresRuntime({ experiments })`
  - provider can “fail closed” until runtime-gated support is confirmed (example: ACP-only experimental path)

Important: generic code never references provider flag names; those live in the provider override.

### 2) Runtime resume probing (ACP loadSession)

Hook:
- `resume.getRuntimeResumePrefetchPlan({ experiments, results })`

Default behavior (when `core.resume.runtimeGate === 'acpLoadSession'`) uses:
- `expo-app/sources/agents/acpRuntimeResume.ts`

### 3) Resume/new-session preflight checks

Hooks:
- `resume.getPreflightPrefetchPlan(...)` (optional)
- `resume.getPreflightIssues(...)`
- `newSession.getPreflightIssues(...)`

Context includes `results` (capability results). If you need dependency/install checks:
- read them from `results` using `capabilities/*` helpers inside the provider folder
- do not pass provider-specific “dep installed” booleans through generic code

### 4) Spawn/resume payload extras

Hooks:
- `payload.buildSpawnSessionExtras(...)`
- `payload.buildResumeSessionExtras(...)`
- `payload.buildWakeResumeExtras(...)`

These are for daemon payload fields that are *not* generic across agents.

### 5) Spawn environment variable transforms (new session)

Hook:
- `payload.buildSpawnEnvironmentVariables({ environmentVariables, newSessionOptions })`

Use this for provider knobs expressed as env vars.

### 6) New-session UI chips + options (no screen hardcoding)

Hooks:
- `newSession.getAgentInputExtraActionChips({ agentOptionState, setAgentOptionState })`
  - return chips to render only for this agent
- `newSession.buildNewSessionOptions({ agentOptionState })`
  - convert local option state to a serializable `newSessionOptions` map for spawn-time hooks

The New Session screen stores draft state generically as:
- `agentNewSessionOptionStateByAgentId[agentId]`

Providers interpret keys within that map (example: `allowIndexing` for Auggie).

---

## Node-safe imports (tests)

Some tests import `@/agents/catalog` in a Node environment. Avoid importing native/icon modules from code that is executed during those imports.

Patterns:
- `catalog.ts` lazy-loads `registryUi.ts` with `require(...)` to avoid image imports in Node.
- If a provider behavior needs a React Native component for chips, lazy-require it inside the hook.

---

## Checklist when adding a new agent

1) Add canonical ID to `packages/agents` (if new id).
2) Add `providers/<agentId>/core.ts` with:
   - correct `cli.detectKey` and `cli.spawnAgent`
   - correct `resume` fields (especially `runtimeGate`)
   - correct `availability.experimental` gating
3) Add `providers/<agentId>/ui.ts` and wire into `registryUi.ts`.
4) Add `providers/<agentId>/uiBehavior.ts` if you need:
   - experimental switches,
   - preflight logic,
   - spawn env vars,
   - new-session chips/options,
   - payload extras.
5) Add/adjust tests:
   - `expo-app/sources/agents/enabled.test.ts` if availability changes
   - `expo-app/sources/agents/registryUiBehavior.test.ts` for new behavior hooks
6) Run:
   - `yarn --cwd expo-app typecheck`
   - relevant `vitest` targets

