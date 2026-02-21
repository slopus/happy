# External Context & Session Linking Design

**Goal:** Enable external systems (DooTask, and future integrations like Linear/Jira) to launch AI sessions through the standard `/new` page with full machine/directory/agent selection, while maintaining bidirectional traceability between sessions and their originating external resources.

**Key Decisions:**
- Reuse `/new` page instead of building separate spawn UI per integration
- Pass complex data via existing `dataId` + `getTempData` mechanism
- Store external context in session metadata for reverse lookup
- AI-generated session titles are NOT locked — ExternalContext.title preserves the original
- AI write-back to external systems is handled by MCP tools, not by this design

---

## 1. ExternalContext Type

A generic structure for linking a session to any external resource.

```typescript
// In tempDataStore.ts

interface ExternalContext {
  source: string;              // Source identifier: 'dootask', 'linear', 'jira', ...
  sourceUrl?: string;          // Source server address
  resourceType: string;        // Resource type: 'task', 'issue', 'ticket', ...
  resourceId: string;          // Resource ID
  title?: string;              // Display title
  deepLink?: string;           // In-app navigation path, e.g. '/dootask/12345'
  extra?: Record<string, unknown>;  // Extension field for source-specific data
}
```

**Uniqueness:** `source` + `resourceType` + `resourceId` uniquely identifies an external resource.

**DooTask example:**
```typescript
{
  source: 'dootask',
  sourceUrl: 'https://task.example.com',
  resourceType: 'task',
  resourceId: '12345',
  title: '2月公积金费用',
  deepLink: '/dootask/12345',
  extra: {
    projectId: 67,
    projectName: '行政采购/支付申请',
  }
}
```

---

## 2. NewSessionData Extension

Extend the existing `NewSessionData` interface with generic fields that any external system can use.

```typescript
// In tempDataStore.ts

interface NewSessionData {
  // --- Existing fields ---
  prompt?: string;
  machineId?: string;
  path?: string;
  agentType?: 'claude' | 'codex' | 'gemini';
  sessionType?: 'simple' | 'worktree';
  taskId?: string;              // Deprecated: use externalContext instead
  taskTitle?: string;           // Deprecated: use externalContext instead

  // --- New generic fields ---
  externalContext?: ExternalContext;
  mcpServers?: Array<{
    name: string;
    url: string;
    headers?: Record<string, string>;
  }>;
  sessionTitle?: string;        // Custom session title (not locked, AI can change)
  sessionIcon?: string;         // Session icon (emoji or icon name)
}
```

---

## 3. MetadataSchema Extension

Add `externalContext` and `sessionIcon` to session metadata for persistent storage and reverse lookup.

```typescript
// In storageTypes.ts, add to MetadataSchema:

externalContext: z.object({
  source: z.string(),
  sourceUrl: z.string().optional(),
  resourceType: z.string(),
  resourceId: z.string(),
  title: z.string().optional(),
  deepLink: z.string().optional(),
  extra: z.record(z.unknown()).optional(),
}).optional(),

sessionIcon: z.string().optional(),
```

---

## 4. /new Page Changes

### 4.1 Read new fields from tempSessionData

The `/new` page already reads `tempSessionData` via `getTempData<NewSessionData>(dataId)`. New fields are consumed as follows:

- `mcpServers` → passed through to `machineSpawnNewSession()`
- `sessionTitle` → passed through to `machineSpawnNewSession()`
- `externalContext` → written to session metadata after spawn
- `sessionIcon` → written to session metadata after spawn
- `prompt` → pre-fills the input field (existing behavior)

### 4.2 handleCreateSession changes

After `machineSpawnNewSession` succeeds:

```typescript
// After spawn success, write external context and icon to metadata
if (tempSessionData?.externalContext || tempSessionData?.sessionIcon) {
  const metadataUpdates: Partial<Metadata> = {};
  if (tempSessionData.externalContext) {
    metadataUpdates.externalContext = tempSessionData.externalContext;
  }
  if (tempSessionData.sessionIcon) {
    metadataUpdates.sessionIcon = tempSessionData.sessionIcon;
  }
  // Metadata write happens after session is created, uses optimistic concurrency
  await sessionUpdateMetadataFields(
    result.sessionId,
    currentMetadata,
    metadataUpdates,
    expectedVersion
  );
}
```

Spawn call changes:
```typescript
const result = await machineSpawnNewSession({
  machineId: selectedMachineId,
  directory: actualPath,
  agent: agentType,
  environmentVariables,
  // New: pass through from tempSessionData
  ...(tempSessionData?.mcpServers ? { mcpServers: tempSessionData.mcpServers } : {}),
  ...(tempSessionData?.sessionTitle ? { sessionTitle: tempSessionData.sessionTitle } : {}),
  // worktree unchanged...
});
```

### 4.3 UI: source context banner

When `tempSessionData?.externalContext` exists, show a non-intrusive banner at the top of the /new page:

```
┌──────────────────────────────────────────┐
│  📋 Creating session for DooTask task    │
│     「2月公积金费用」                      │
└──────────────────────────────────────────┘
```

The banner is informational only. User still selects machine, directory, and agent as normal.

---

## 5. DooTask Task Detail Page Changes

### 5.1 handleStartAiSession simplification

Replace the current spawn logic (~50 lines) with a data-preparation + navigation call (~30 lines):

```typescript
const handleStartAiSession = React.useCallback(() => {
  if (!profile || !task) return;

  const dataId = storeTempData({
    prompt: [
      'I need your help with a task from DooTask.',
      `Task ID: ${task.id}`,
      `Title: ${task.name}`,
      `Project: ${task.project_name}`,
      task.desc ? `Description:\n${task.desc}` : '',
      '',
      'Use DooTask MCP tools when needed.',
    ].filter(Boolean).join('\n'),
    sessionTitle: `DooTask: ${task.name}`,
    sessionIcon: '📋',
    mcpServers: [{
      name: 'dootask',
      url: `${profile.serverUrl}/apps/mcp_server/mcp`,
      headers: { Authorization: `Bearer ${profile.token}` },
    }],
    externalContext: {
      source: 'dootask',
      sourceUrl: profile.serverUrl,
      resourceType: 'task',
      resourceId: String(task.id),
      title: task.name,
      deepLink: `/dootask/${task.id}`,
      extra: {
        projectId: task.project_id,
        projectName: task.project_name,
      },
    },
  } satisfies NewSessionData);

  router.push(`/new?dataId=${dataId}`);
}, [profile, task, router]);
```

**Removed:** `spawning` state, machine selection logic, error handling for spawn, draft writing.

### 5.2 Linked sessions list

Show sessions linked to this task on the detail page.

**Hook:**
```typescript
// hooks/useLinkedSessions.ts
function useLinkedSessions(source: string, resourceId: string) {
  const sessions = storage((s) => s.sessions);
  return React.useMemo(() => {
    return Object.values(sessions)
      .filter((s) => {
        const ctx = s.metadata?.externalContext;
        return ctx?.source === source && ctx?.resourceId === resourceId;
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [sessions, source, resourceId]);
}
```

**UI on task detail page:**

```
┌─────────────────────────────────┐
│  (task description & content)   │
├─────────────────────────────────┤
│  Related Sessions (2)           │
│                                 │
│  ┌─ 分析公积金缴费明细表 ──────┐  │
│  │  claude · mac-mini · 2h ago │  │
│  └─────────────────────────────┘  │
│  ┌─ 修复汇缴确认书模板 ──────┐   │
│  │  codex · dev-server · 1d   │   │
│  └─────────────────────────────┘  │
├─────────────────────────────────┤
│       [ Start AI Session ]      │
└─────────────────────────────────┘
```

- Tap session card → navigate to session
- Hidden when no linked sessions exist
- Each card shows: AI-generated title, agent type, machine name, relative time

---

## 6. Scope Exclusions

The following are explicitly **not** in scope for this design:

- **Session-side reverse entry:** No UI in the session view to jump back to the task (deferred — needs further design thinking)
- **AI write-back to tasks:** Handled by existing MCP tools, not a UI concern
- **Project-level machine/directory binding:** Nice-to-have for future, not needed now
- **Deep linking from external apps:** No URL scheme handling (future consideration)

---

## 7. Files to Modify

| File | Change |
|------|--------|
| `sources/utils/tempDataStore.ts` | Add `ExternalContext` type, extend `NewSessionData` |
| `sources/sync/storageTypes.ts` | Add `externalContext` and `sessionIcon` to `MetadataSchema` |
| `sources/app/(app)/new/index.tsx` | Read & pass through new fields in `handleCreateSession`, add context banner |
| `sources/app/(app)/dootask/[taskId].tsx` | Simplify `handleStartAiSession`, add linked sessions list |
| `sources/hooks/useLinkedSessions.ts` | New hook for reverse lookup |
