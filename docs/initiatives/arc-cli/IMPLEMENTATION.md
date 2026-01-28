# Arc CLI Implementation Plan

**Status:** Draft
**Created:** 2026-01-25
**Repo:** `runline/arc`

---

## Overview

Arc CLI is a fork of Happy CLI with Runline-specific features. The goal is to maintain upstream compatibility while adding:

1. **Agent identity** — Read `.arc.yaml` for display name, avatar, voice
2. **Observability** — OTEL trace capture via `--trace`
3. **Enterprise features** — Team management, SOPs, audit logs
4. **Arc subcommand** — `arc` namespace for Arc-specific operations

---

## Architecture Principle: Upstream Isolation

**Golden rule:** All Arc-specific code lives in `src/arc/`. Happy files get minimal, surgical modifications.

```
arc/cli/
├── src/
│   ├── index.ts              # Entry point (MINIMAL changes - see below)
│   ├── arc/                   # ← ALL ARC-SPECIFIC CODE LIVES HERE
│   │   ├── index.ts          # Arc subcommand router
│   │   ├── agent.ts          # .arc.yaml loading
│   │   ├── trace.ts          # OTEL collector management
│   │   ├── config.ts         # Arc configuration
│   │   ├── hooks.ts          # Arc-specific hooks into Happy
│   │   └── commands/         # Arc subcommands
│   │       ├── trace.ts      # arc trace view/list/server
│   │       ├── agent.ts      # arc agent info/list
│   │       └── init.ts       # arc init
│   └── ...                   # Happy sources (MINIMAL modification)
```

### Modification Strategy for Happy Files

**Pattern for modifying Happy files (keep minimal, well-commented):**

```typescript
// ═══════════════════════════════════════════════════════════════
// ARC MODIFICATION START - upstream merge point
// ═══════════════════════════════════════════════════════════════
import { handleArcCommand, processArcFlags, arcEnrichSession } from './arc'

// ... minimal Arc integration code ...

// ═══════════════════════════════════════════════════════════════
// ARC MODIFICATION END
// ═══════════════════════════════════════════════════════════════
```

**Allowed in Happy files:**
| Type | Example | Location |
|------|---------|----------|
| Imports | `import { ... } from './arc'` | Top of file |
| Hook calls | `arcEnrichSession(session)` | Specific integration points |
| Flag parsing | `case '--trace': options.arcTrace = true` | Arg parsing block |
| Subcommand routing | `case 'arc': return handleArcCommand(...)` | Subcommand switch |

**NOT allowed in Happy files:**
- Arc business logic → put in `src/arc/`
- Arc configuration → put in `src/arc/config.ts`
- Arc-specific types → put in `src/arc/types.ts`
- Large code blocks → wrap in function, call from Happy

### Upstream Sync Strategy

**Setup (one-time):**
```bash
git remote add upstream https://github.com/slopus/happy.git
git fetch upstream
```

**Regular merge process:**
```bash
# 1. Fetch upstream
git fetch upstream

# 2. Create merge branch
git checkout -b merge/happy-$(date +%Y%m%d)

# 3. Merge upstream main
git merge upstream/main

# 4. Resolve conflicts (should be minimal if we follow the rules)
#    Conflicts in:
#    - src/arc/*           → Keep ours (Arc-specific, upstream doesn't have)
#    - src/*.ts            → Merge carefully, preserve ARC MODIFICATION blocks
#    - expo-app/sources/arc/* → Keep ours (Arc-specific)

# 5. Test
yarn build && yarn test

# 6. PR to main
git push origin merge/happy-$(date +%Y%m%d)
```

**Conflict prevention checklist:**
- [ ] Arc code isolated in `src/arc/` → Never conflicts with upstream
- [ ] Happy modifications marked with `ARC MODIFICATION` → Easy to find
- [ ] No renaming/moving Happy files → Clean merge history
- [ ] No reformatting Happy files → Avoid noise diffs

---

## Phase 1: Foundation

### 1.1 Arc Subcommand Router

**File:** `src/arc/index.ts`

```typescript
export async function handleArcCommand(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'trace':
      return handleTraceCommand(args.slice(1))
    case 'agent':
      return handleAgentCommand(args.slice(1))
    case 'init':
      return handleInitCommand(args.slice(1))
    case 'version':
      return showArcVersion()
    default:
      showArcHelp()
  }
}
```

**Modify:** `src/index.ts` (line ~355)

```typescript
// Add after existing subcommand checks
case 'arc':
  return handleArcCommand(args.slice(1))
```

### 1.2 Arc Configuration

**File:** `src/arc/config.ts`

```typescript
import { join } from 'path'
import { homedir } from 'os'

export interface ArcConfig {
  homeDir: string           // ~/.arc
  tracesDir: string         // ~/.arc/traces
  agentCacheDir: string     // ~/.arc/agents
  otelEndpoint: string      // default: http://localhost:4318
  grafanaCloudKey?: string  // optional cloud sync
}

export function getArcConfig(): ArcConfig {
  const homeDir = process.env.ARC_HOME_DIR || join(homedir(), '.arc')
  return {
    homeDir,
    tracesDir: join(homeDir, 'traces'),
    agentCacheDir: join(homeDir, 'agents'),
    otelEndpoint: process.env.ARC_OTEL_ENDPOINT || 'http://localhost:4318',
    grafanaCloudKey: process.env.ARC_GRAFANA_CLOUD_KEY,
  }
}
```

### 1.3 .arc.yaml Loader

**File:** `src/arc/agent.ts`

```typescript
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { parse } from 'yaml'

export interface ArcAgent {
  name: string
  tagline?: string
  avatar?: string | 'generated'
  voice?: {
    elevenlabs_agent_id?: string
  }
}

export function loadArcAgent(projectDir: string): ArcAgent | null {
  const arcYamlPath = join(projectDir, '.arc.yaml')

  if (!existsSync(arcYamlPath)) {
    return null
  }

  try {
    const content = readFileSync(arcYamlPath, 'utf-8')
    const parsed = parse(content)
    return {
      name: parsed.agent?.name || 'Unknown Agent',
      tagline: parsed.agent?.tagline,
      avatar: parsed.agent?.avatar,
      voice: parsed.voice,
    }
  } catch (e) {
    console.error(`Failed to parse .arc.yaml: ${e}`)
    return null
  }
}
```

---

## Phase 2: Tracing (`--trace`)

### 2.1 OTEL Collector Management

**File:** `src/arc/trace.ts`

```typescript
import { spawn, ChildProcess } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getArcConfig } from './config'

let collectorProcess: ChildProcess | null = null

const COLLECTOR_CONFIG = `
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  file:
    path: {{TRACES_DIR}}/current.jsonl

processors:
  batch:
    timeout: 1s

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [file]
`

export async function ensureCollectorRunning(): Promise<string> {
  const config = getArcConfig()

  // Check if collector already running
  if (await isCollectorHealthy(config.otelEndpoint)) {
    return config.otelEndpoint
  }

  // Ensure traces dir exists
  mkdirSync(config.tracesDir, { recursive: true })

  // Write collector config
  const configPath = join(config.homeDir, 'otel-collector.yaml')
  const configContent = COLLECTOR_CONFIG.replace('{{TRACES_DIR}}', config.tracesDir)
  writeFileSync(configPath, configContent)

  // Start collector (assume otelcol-contrib is installed)
  collectorProcess = spawn('otelcol-contrib', ['--config', configPath], {
    detached: true,
    stdio: 'ignore',
  })
  collectorProcess.unref()

  // Wait for healthy
  await waitForCollector(config.otelEndpoint)

  return config.otelEndpoint
}

async function isCollectorHealthy(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function waitForCollector(endpoint: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isCollectorHealthy(endpoint)) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('OTEL collector failed to start')
}

export function stopCollector(): void {
  if (collectorProcess) {
    collectorProcess.kill()
    collectorProcess = null
  }
}
```

### 2.2 --trace Flag Integration

**Modify:** `src/index.ts` (around line 503)

```typescript
} else if (arg === '--trace') {
  options.arcTrace = true
}
```

**Modify:** `src/claude/types.ts`

```typescript
export interface StartOptions {
  // ... existing fields
  arcTrace?: boolean
}
```

**Modify:** `src/claude/runClaude.ts` (around line 80)

```typescript
import { ensureCollectorRunning } from '../arc/trace'

// Inside runClaude(), before loop()
if (options.arcTrace) {
  const otelEndpoint = await ensureCollectorRunning()
  options.claudeEnvVars = options.claudeEnvVars || {}
  options.claudeEnvVars['OTEL_EXPORTER_OTLP_ENDPOINT'] = otelEndpoint
  options.claudeEnvVars['OTEL_SERVICE_NAME'] = 'claude-code'
}
```

### 2.3 Trace Subcommands

**File:** `src/arc/commands/trace.ts`

```typescript
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getArcConfig } from '../config'

export async function handleTraceCommand(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'list':
      return listTraces()
    case 'view':
      return viewTrace(args[1])
    case 'server':
      return startTraceServer()
    default:
      showTraceHelp()
  }
}

function listTraces(): void {
  const config = getArcConfig()
  const files = readdirSync(config.tracesDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const path = join(config.tracesDir, f)
      const stat = statSync(path)
      return { name: f, size: stat.size, modified: stat.mtime }
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())

  console.log('Recent traces:')
  for (const file of files.slice(0, 10)) {
    const sizeKb = Math.round(file.size / 1024)
    console.log(`  ${file.name} (${sizeKb}KB) - ${file.modified.toLocaleString()}`)
  }
}

async function viewTrace(tracePath: string): Promise<void> {
  // Generate HTML report using claude-trace logic
  // Or open in Grafana if running
  console.log(`Viewing trace: ${tracePath}`)
  // TODO: Implement HTML generation or Grafana link
}

async function startTraceServer(): Promise<void> {
  // Start Tempo + Grafana via Docker Compose
  console.log('Starting trace server (Tempo + Grafana)...')
  // TODO: Implement docker-compose up
}
```

---

## Phase 3: Agent Identity

### 3.1 Agent Metadata in Session

**Modify:** `src/claude/session.ts`

```typescript
import { loadArcAgent, ArcAgent } from '../arc/agent'

export class Session {
  // ... existing fields
  arcAgent: ArcAgent | null = null

  constructor(/* ... */) {
    // ... existing code
    this.arcAgent = loadArcAgent(process.cwd())
  }
}
```

### 3.2 Agent Display Name in UI

**Modify:** `src/claude/utils/claudeRemoteLauncher.tsx`

The remote UI shows session info. Update to use `session.arcAgent.name` if available.

### 3.3 Agent Subcommand

**File:** `src/arc/commands/agent.ts`

```typescript
import { loadArcAgent } from '../agent'

export async function handleAgentCommand(args: string[]): Promise<void> {
  const subcommand = args[0]

  switch (subcommand) {
    case 'info':
      return showAgentInfo()
    default:
      showAgentHelp()
  }
}

function showAgentInfo(): void {
  const agent = loadArcAgent(process.cwd())

  if (!agent) {
    console.log('No .arc.yaml found in current directory.')
    console.log('Run `arc init` to create one.')
    return
  }

  console.log(`Agent: ${agent.name}`)
  if (agent.tagline) console.log(`Tagline: ${agent.tagline}`)
  if (agent.avatar) console.log(`Avatar: ${agent.avatar}`)
  if (agent.voice?.elevenlabs_agent_id) {
    console.log(`Voice: ElevenLabs (${agent.voice.elevenlabs_agent_id})`)
  }
}
```

---

## Phase 4: CLI Rename & Branding

### 4.1 Binary Name

**Modify:** `package.json`

```json
{
  "name": "@runline/arc-cli",
  "bin": {
    "arc": "dist/index.mjs",
    "happy": "dist/index.mjs"  // Keep for backwards compat
  }
}
```

### 4.2 Help Text

**Modify:** `src/index.ts` (help output)

```typescript
function showHelp() {
  console.log(`
arc - Runline Agent Runner Command

Usage:
  arc [options]            Start Claude with Arc features
  arc trace <command>      Manage traces
  arc agent <command>      Agent identity management
  arc init                 Initialize .arc.yaml

Options:
  --trace                  Enable OTEL trace capture
  --yolo                   Bypass permissions
  --claude-env KEY=VALUE   Set environment variable

Upstream Happy commands also available:
  arc auth                 Manage authentication
  arc daemon               Manage background service
  arc doctor               System diagnostics
`)
}
```

---

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/index.ts` | Modify | Add `arc` subcommand, `--trace` flag |
| `src/claude/types.ts` | Modify | Add `arcTrace` to StartOptions |
| `src/claude/runClaude.ts` | Modify | Start OTEL collector if tracing |
| `src/claude/session.ts` | Modify | Load .arc.yaml, store agent |
| `src/arc/index.ts` | **New** | Arc subcommand router |
| `src/arc/config.ts` | **New** | Arc configuration |
| `src/arc/agent.ts` | **New** | .arc.yaml loader |
| `src/arc/trace.ts` | **New** | OTEL collector management |
| `src/arc/commands/trace.ts` | **New** | Trace subcommands |
| `src/arc/commands/agent.ts` | **New** | Agent subcommands |
| `src/arc/commands/init.ts` | **New** | Initialize .arc.yaml |
| `package.json` | Modify | Rename, add `arc` bin |

---

## Dependencies to Add

```json
{
  "dependencies": {
    "yaml": "^2.3.0"  // .arc.yaml parsing
  }
}
```

**External (user must install):**
- `otelcol-contrib` — OTEL collector binary (or Docker)
- Docker (optional) — For Tempo + Grafana

---

## Testing Plan

| Test | Description |
|------|-------------|
| `arc --help` | Shows Arc-specific help |
| `arc --trace` | Starts OTEL collector, traces captured |
| `arc trace list` | Lists traces in ~/.arc/traces |
| `arc agent info` | Shows .arc.yaml contents |
| `arc init` | Creates .arc.yaml template |
| Upstream compat | All `happy` commands still work |

---

## Rollout

1. **Alpha** — Internal testing with Emila repo
2. **Beta** — Runline team usage
3. **GA** — Public release, npm publish

---

## Open Questions

1. **OTEL collector install** — Bundle binary? Use Docker? Require user install?
2. **Trace storage** — Local only for v1? Cloud sync later?
3. **Binary name** — `arc` only, or keep `happy` alias forever?
4. **Upstream sync** — How often to merge Happy updates?

---

## Phase 5: Task Sync (Project Management Integration)

### 5.1 Overview

Arc provides a **provider-agnostic task sync interface** that bridges Claude Code's native TodoWrite with external project management tools. Instead of hardcoding Linear, we define a **Task Sync Skill** interface that providers implement.

### 5.2 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Session                       │
│                                                             │
│  TodoWrite ──────┐                                          │
│                  │                                          │
│                  ▼                                          │
│  ┌─────────────────────────────────────┐                   │
│  │      Arc Task Sync Interface        │                   │
│  │  (PreToolUse hook on TodoWrite)     │                   │
│  └──────────────────┬──────────────────┘                   │
│                     │                                       │
└─────────────────────┼───────────────────────────────────────┘
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐
│   Linear   │ │   Jira     │ │   Asana    │
│  Provider  │ │  Provider  │ │  Provider  │
│  (skill)   │ │  (skill)   │ │  (skill)   │
└────────────┘ └────────────┘ └────────────┘
```

### 5.3 Task Sync Skill Interface

Providers implement a skill at `skills/<provider>-task-sync/SKILL.md`:

```yaml
# .arc.yaml task sync configuration
task_sync:
  provider: linear          # linear | jira | asana | github | custom
  skill: linear-task-sync   # skill name
  config:
    project_id: "PRJ-123"   # provider-specific
    sync_mode: bidirectional # readonly | writeonly | bidirectional
```

**Standard sync operations (all providers must support):**

| Operation | Description | TodoWrite Mapping |
|-----------|-------------|-------------------|
| `project.get` | Get project/board info | — |
| `task.create` | Create task/issue | `status: pending` |
| `task.update` | Update task | `status: in_progress` |
| `task.complete` | Mark done | `status: completed` |
| `task.list` | List tasks | TodoRead equivalent |
| `comment.add` | Add comment to task | Tool result annotation |

**Optional operations:**

| Operation | Description |
|-----------|-------------|
| `sprint.get` | Get current sprint/iteration |
| `assignee.set` | Assign to user |
| `label.add` | Add labels/tags |
| `link.attach` | Link to PR/commit |

### 5.4 PreToolUse Hook Implementation

**File:** `src/arc/hooks/task-sync.ts`

```typescript
import { loadArcConfig } from '../config'
import { invokeSkill } from '../skills'

interface TodoWritePayload {
  todos: Array<{
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm: string
  }>
}

export async function handleTodoWriteHook(payload: TodoWritePayload): Promise<void> {
  const config = loadArcConfig()

  if (!config.task_sync?.provider) {
    return // No sync configured, let TodoWrite proceed normally
  }

  const skill = config.task_sync.skill
  const providerConfig = config.task_sync.config

  // Diff against previous state to detect changes
  const changes = diffTodos(payload.todos)

  for (const change of changes) {
    switch (change.type) {
      case 'added':
        await invokeSkill(skill, 'task.create', {
          title: change.todo.content,
          ...providerConfig
        })
        break
      case 'status_changed':
        if (change.newStatus === 'completed') {
          await invokeSkill(skill, 'task.complete', { id: change.externalId })
        } else {
          await invokeSkill(skill, 'task.update', {
            id: change.externalId,
            status: mapStatus(change.newStatus, config.task_sync.provider)
          })
        }
        break
    }
  }
}
```

### 5.5 Provider Skill Example: Linear

**File:** `skills/linear-task-sync/SKILL.md`

```markdown
---
name: linear-task-sync
description: Sync Arc tasks with Linear issues
---

# Linear Task Sync

Syncs TodoWrite operations to Linear via MCP.

## Operations

### task.create
Creates a Linear issue from a todo item.

Uses: `mcp__linear__create_issue`
Maps:
- `content` → `title`
- `project_id` → `projectId`
- `status: pending` → Linear "Backlog" state

### task.complete
Marks Linear issue as done.

Uses: `mcp__linear__update_issue`
Maps:
- `status: completed` → Linear "Done" state

### task.list
Lists issues from configured project.

Uses: `mcp__linear__list_issues`
```

### 5.6 Configuration Examples

**Linear:**
```yaml
# .arc.yaml
task_sync:
  provider: linear
  skill: linear-task-sync
  config:
    team_id: "TEAM-123"
    project_id: "PRJ-456"
    default_state: "backlog"
```

**Jira:**
```yaml
task_sync:
  provider: jira
  skill: jira-task-sync
  config:
    project_key: "ARC"
    issue_type: "Task"
    board_id: "123"
```

**Asana:**
```yaml
task_sync:
  provider: asana
  skill: asana-task-sync
  config:
    project_gid: "1234567890"
    workspace_gid: "0987654321"
```

**GitHub Issues:**
```yaml
task_sync:
  provider: github
  skill: github-task-sync
  config:
    repo: "runline/arc"
    labels: ["arc-task"]
```

### 5.7 CLI Commands

```bash
# Show sync status
arc tasks status

# Force sync (pull from provider)
arc tasks sync

# List tasks (from provider, not TodoWrite)
arc tasks list

# Configure provider
arc tasks config --provider linear --project PRJ-123
```

### 5.8 Sync Modes

| Mode | TodoWrite → Provider | Provider → TodoWrite |
|------|---------------------|---------------------|
| `readonly` | ❌ | ✅ (populate from provider) |
| `writeonly` | ✅ | ❌ (one-way push) |
| `bidirectional` | ✅ | ✅ (full sync) |

### 5.9 Open Questions

1. **Conflict resolution** — What if task updated in both places?
2. **ID mapping** — How to persist TodoWrite ↔ External ID mapping?
3. **Offline mode** — Queue syncs when provider unavailable?
4. **Bulk operations** — Batch API calls for performance?

---

## Timeline

| Phase | Deliverable | Effort |
|-------|-------------|--------|
| 1 | Foundation (arc subcommand, config, agent loader) | 1-2 days |
| 2 | Tracing (--trace, collector, subcommands) | 2-3 days |
| 3 | Agent identity (session metadata, UI) | 1 day |
| 4 | CLI rename & branding | 0.5 days |
| 5 | Task sync interface + Linear provider | 2-3 days |

**Total:** ~7-10 days for full Arc CLI
