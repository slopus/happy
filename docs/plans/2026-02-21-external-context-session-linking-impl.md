# External Context & Session Linking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable external systems to launch AI sessions through `/new` with full machine/directory/agent selection, and store external context in session metadata for reverse lookup.

**Architecture:** Extend `NewSessionData` with generic `ExternalContext`, `mcpServers`, `sessionTitle`, `sessionIcon` fields. DooTask task detail page passes these via existing `dataId` + `getTempData` mechanism to `/new`. After spawn, `/new` writes external context to session metadata. Task detail page queries sessions by external context for reverse lookup.

**Tech Stack:** React Native (Expo Router), Zustand + MMKV, TypeScript, Zod

**Design doc:** `docs/plans/2026-02-21-external-context-session-linking-design.md`

---

## Task 1: Add ExternalContext Type & Extend NewSessionData

**Files:**
- Modify: `packages/happy-app/sources/utils/tempDataStore.ts`

**Step 1: Add ExternalContext interface and extend NewSessionData**

Replace the current `NewSessionData` interface (lines 8-16) with:

```typescript
export interface ExternalContext {
    source: string;
    sourceUrl?: string;
    resourceType: string;
    resourceId: string;
    title?: string;
    deepLink?: string;
    extra?: Record<string, unknown>;
}

export interface NewSessionData {
    prompt?: string;
    machineId?: string;
    path?: string;
    agentType?: 'claude' | 'codex' | 'gemini';
    sessionType?: 'simple' | 'worktree';
    /** @deprecated Use externalContext instead */
    taskId?: string;
    /** @deprecated Use externalContext instead */
    taskTitle?: string;
    externalContext?: ExternalContext;
    mcpServers?: Array<{
        name: string;
        url: string;
        headers?: Record<string, string>;
    }>;
    sessionTitle?: string;
    sessionIcon?: string;
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd packages/happy-app && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No new errors related to tempDataStore.ts

**Step 3: Commit**

```bash
git add packages/happy-app/sources/utils/tempDataStore.ts
git commit -m "feat: add ExternalContext type and extend NewSessionData"
```

---

## Task 2: Extend MetadataSchema

**Files:**
- Modify: `packages/happy-app/sources/sync/storageTypes.ts`

**Step 1: Add externalContext and sessionIcon to MetadataSchema**

In `storageTypes.ts`, add these two fields to the `MetadataSchema` z.object (after `reviewOfSessionId` on line 33, before the closing `});` on line 34):

```typescript
    reviewOfSessionId: z.string().optional(), // Links review session to the session being reviewed
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
});
```

**Step 2: Verify TypeScript compiles**

Run: `cd packages/happy-app && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors. The `Metadata` type auto-infers from the schema.

**Step 3: Commit**

```bash
git add packages/happy-app/sources/sync/storageTypes.ts
git commit -m "feat: add externalContext and sessionIcon to MetadataSchema"
```

---

## Task 3: /new Page — Pass Through mcpServers & sessionTitle in Spawn

**Files:**
- Modify: `packages/happy-app/sources/app/(app)/new/index.tsx`

**Step 1: Add storeTempData import**

The file already imports `getTempData` and `NewSessionData` from `@/utils/tempDataStore` (line 22). No new imports needed for this task.

**Step 2: Pass mcpServers and sessionTitle to machineSpawnNewSession**

In `handleCreateSession` (line 1090-1101), modify the `machineSpawnNewSession` call. Change from:

```typescript
            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: actualPath,
                approvedNewDirectoryCreation: true,
                agent: agentType,
                environmentVariables,
                // Pass worktree metadata so CLI includes it in initial metadata (avoids race condition)
                ...(sessionType === 'worktree' && worktreeBranchName ? {
                    worktreeBasePath: selectedPath,
                    worktreeBranchName,
                } : {}),
            });
```

To:

```typescript
            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: actualPath,
                approvedNewDirectoryCreation: true,
                agent: agentType,
                environmentVariables,
                // Pass worktree metadata so CLI includes it in initial metadata (avoids race condition)
                ...(sessionType === 'worktree' && worktreeBranchName ? {
                    worktreeBasePath: selectedPath,
                    worktreeBranchName,
                } : {}),
                // Pass through external MCP servers and session title
                ...(tempSessionData?.mcpServers ? { mcpServers: tempSessionData.mcpServers } : {}),
                ...(tempSessionData?.sessionTitle ? { sessionTitle: tempSessionData.sessionTitle } : {}),
            });
```

**Step 3: Verify TypeScript compiles**

Run: `cd packages/happy-app && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors (mcpServers and sessionTitle already exist on SpawnSessionOptions).

**Step 4: Commit**

```bash
git add packages/happy-app/sources/app/(app)/new/index.tsx
git commit -m "feat(/new): pass through mcpServers and sessionTitle from tempSessionData"
```

---

## Task 4: /new Page — Write ExternalContext to Metadata After Spawn

**Files:**
- Modify: `packages/happy-app/sources/app/(app)/new/index.tsx`

**Step 1: Add sessionUpdateMetadataFields import**

Add `sessionUpdateMetadataFields` to the existing import from `@/sync/ops` (line 17):

```typescript
import { machineSpawnNewSession, sessionUpdateMetadataFields } from '@/sync/ops';
```

**Step 2: Write metadata after spawn success**

In `handleCreateSession`, after `await sync.refreshSessions();` (line 1107) and before the permission mode updates (line 1109), add:

```typescript
                await sync.refreshSessions();

                // Write external context and session icon to metadata
                if (tempSessionData?.externalContext || tempSessionData?.sessionIcon) {
                    const freshSession = storage.getState().sessions[result.sessionId];
                    if (freshSession?.metadata) {
                        try {
                            await sessionUpdateMetadataFields(
                                result.sessionId,
                                freshSession.metadata,
                                {
                                    ...(tempSessionData.externalContext ? { externalContext: tempSessionData.externalContext } : {}),
                                    ...(tempSessionData.sessionIcon ? { sessionIcon: tempSessionData.sessionIcon } : {}),
                                },
                                freshSession.metadataVersion
                            );
                        } catch (e) {
                            console.warn('Failed to write external context to session metadata:', e);
                        }
                    }
                }

                // Set permission mode and model mode on the session
```

**Note:** This follows the exact same pattern as `info.tsx:578-592` (review session linking): refresh → get fresh session → update metadata fields → catch and warn.

**Step 3: Add tempSessionData to handleCreateSession dependency array**

In the dependency array of `handleCreateSession` (line 1142), add `tempSessionData`:

```typescript
    }, [selectedMachineId, selectedPath, sessionPrompt, sessionType, agentType, selectedProfileId, permissionMode, modelMode, recentMachinePaths, profileMap, router, images, clearImages, tempSessionData]);
```

**Step 4: Verify TypeScript compiles**

Run: `cd packages/happy-app && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

**Step 5: Commit**

```bash
git add packages/happy-app/sources/app/(app)/new/index.tsx
git commit -m "feat(/new): write externalContext and sessionIcon to metadata after spawn"
```

---

## Task 5: /new Page — Add Context Banner UI

**Files:**
- Modify: `packages/happy-app/sources/app/(app)/new/index.tsx`

**Step 1: Identify banner insertion point**

Look for the main content area in both wizard variants (Control A and Variant B). The banner should appear at the very top of the scrollable content, before machine/path selection.

Search for the ScrollView or main container that holds the wizard content. The banner should be a simple View with Text inside it, appearing when `tempSessionData?.externalContext` is set.

**Step 2: Create the banner component inline**

Add this inside the component, before the return statement (after the useMemo/useCallback hooks, around line 1036):

```typescript
    const externalContextBanner = tempSessionData?.externalContext ? (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 8,
            backgroundColor: theme.colors.surface,
            borderRadius: 10,
            marginBottom: 8,
        }}>
            {tempSessionData.sessionIcon ? (
                <Text style={{ fontSize: 18 }}>{tempSessionData.sessionIcon}</Text>
            ) : null}
            <View style={{ flex: 1 }}>
                <Text style={[{ ...Typography.default(), fontSize: 13, color: theme.colors.textSecondary }]}>
                    {tempSessionData.externalContext.source === 'dootask' ? 'DooTask' : tempSessionData.externalContext.source}
                </Text>
                {tempSessionData.externalContext.title ? (
                    <Text style={[{ ...Typography.default('semiBold'), fontSize: 14, color: theme.colors.text }]} numberOfLines={1}>
                        {tempSessionData.externalContext.title}
                    </Text>
                ) : null}
            </View>
        </View>
    ) : null;
```

**Step 3: Render the banner**

Insert `{externalContextBanner}` at the top of both wizard variant layouts. Search for where the machine selection and agent input areas start in both Control A and Variant B, and place it before those sections.

For Control A (simpler layout), look for the main content View and add `{externalContextBanner}` as the first child.

For Variant B (enhanced wizard), add `{externalContextBanner}` before the profile selection section.

**Step 4: Verify TypeScript compiles and visually inspect**

Run: `cd packages/happy-app && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

**Step 5: Commit**

```bash
git add packages/happy-app/sources/app/(app)/new/index.tsx
git commit -m "feat(/new): show external context banner when launching from external system"
```

---

## Task 6: Simplify DooTask handleStartAiSession

**Files:**
- Modify: `packages/happy-app/sources/app/(app)/dootask/[taskId].tsx`

**Step 1: Update imports**

Replace line 10:
```typescript
import { machineSpawnNewSession } from '@/sync/ops';
```
With:
```typescript
import { storeTempData, type NewSessionData } from '@/utils/tempDataStore';
```

Remove line 11 (no longer needed):
```typescript
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
```

**Step 2: Remove unused state and hook**

Remove line 184:
```typescript
    const navigateToSession = useNavigateToSession();
```

Remove line 195:
```typescript
    const [spawning, setSpawning] = React.useState(false);
```

**Step 3: Replace handleStartAiSession**

Replace lines 459-507 with:

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

**Step 4: Update the AI button UI**

Replace lines 701-713 (the spawning button) with a simpler version that doesn't need spawning state:

```tsx
            <Pressable
                style={[styles.aiButton, { backgroundColor: theme.colors.button.primary.background }]}
                onPress={handleStartAiSession}
            >
                <Text style={[styles.aiButtonText, { color: theme.colors.button.primary.tint }]}>
                    {t('dootask.startAiSession')}
                </Text>
            </Pressable>
```

**Step 5: Verify TypeScript compiles**

Run: `cd packages/happy-app && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

**Step 6: Commit**

```bash
git add packages/happy-app/sources/app/(app)/dootask/[taskId].tsx
git commit -m "refactor(dootask): simplify handleStartAiSession to use /new page with ExternalContext"
```

---

## Task 7: Create useLinkedSessions Hook

**Files:**
- Create: `packages/happy-app/sources/hooks/useLinkedSessions.ts`

**Step 1: Create the hook**

```typescript
import * as React from 'react';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';

export function useLinkedSessions(source: string, resourceId: string): Session[] {
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

**Step 2: Verify TypeScript compiles**

Run: `cd packages/happy-app && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

**Step 3: Commit**

```bash
git add packages/happy-app/sources/hooks/useLinkedSessions.ts
git commit -m "feat: add useLinkedSessions hook for reverse lookup by ExternalContext"
```

---

## Task 8: Add Linked Sessions List to DooTask Task Detail Page

**Files:**
- Modify: `packages/happy-app/sources/app/(app)/dootask/[taskId].tsx`

**Step 1: Add imports**

Add these imports at the top of the file:

```typescript
import { useLinkedSessions } from '@/hooks/useLinkedSessions';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getSessionName } from '@/utils/sessionUtils';
```

Note: `useNavigateToSession` was removed in Task 6 but is needed again here for navigating to linked sessions.

**Step 2: Add the hook call and navigation**

Inside the `DooTaskDetail` component, after the existing state declarations (around line 198), add:

```typescript
    const linkedSessions = useLinkedSessions('dootask', String(id));
    const navigateToSession = useNavigateToSession();
```

**Step 3: Add linked sessions UI**

Before the AI button (right before the `<Pressable style={[styles.aiButton` line), add:

```tsx
            {linkedSessions.length > 0 ? (
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                        {t('dootask.relatedSessions')} ({linkedSessions.length})
                    </Text>
                    {linkedSessions.map((session) => (
                        <Pressable
                            key={session.id}
                            style={[styles.sessionCard, { backgroundColor: theme.colors.surface }]}
                            onPress={() => navigateToSession(session.id)}
                        >
                            <Text style={[styles.sessionTitle, { color: theme.colors.text }]} numberOfLines={1}>
                                {getSessionName(session)}
                            </Text>
                            <Text style={[styles.sessionMeta, { color: theme.colors.textSecondary }]}>
                                {session.metadata?.host ?? ''}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            ) : null}
```

**Step 4: Add styles**

In the `styles` StyleSheet (around line 744), add:

```typescript
    sessionCard: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
        gap: 2,
    },
    sessionTitle: { ...Typography.default('semiBold'), fontSize: 14 },
    sessionMeta: { ...Typography.default(), fontSize: 12 },
```

**Step 5: Add translation key**

Find the translation files and add the `dootask.relatedSessions` key. Search for existing `dootask.` keys to find the right files:
- English: "Related Sessions"
- Chinese: "相关会话"

**Step 6: Verify TypeScript compiles**

Run: `cd packages/happy-app && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors.

**Step 7: Commit**

```bash
git add packages/happy-app/sources/app/(app)/dootask/[taskId].tsx packages/happy-app/sources/hooks/useLinkedSessions.ts
git commit -m "feat(dootask): show linked sessions list on task detail page"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | ExternalContext type + NewSessionData extension | `tempDataStore.ts` |
| 2 | MetadataSchema extension | `storageTypes.ts` |
| 3 | /new: pass mcpServers + sessionTitle to spawn | `new/index.tsx` |
| 4 | /new: write externalContext to metadata after spawn | `new/index.tsx` |
| 5 | /new: context banner UI | `new/index.tsx` |
| 6 | DooTask: simplify handleStartAiSession | `dootask/[taskId].tsx` |
| 7 | useLinkedSessions hook | `hooks/useLinkedSessions.ts` |
| 8 | DooTask: linked sessions list | `dootask/[taskId].tsx` |
