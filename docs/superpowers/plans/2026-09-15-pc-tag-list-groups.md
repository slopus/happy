# PC Tag List Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PC Tag pills with native Paws rows, open a list-grouped Tag detail dialog with a standalone archive group and persistent archive visibility, and allow deleting only the Tag and its session associations.

**Architecture:** Keep `SidebarOrganization` as the source of truth. Add one pure grouping function beside the existing sidebar indexes, render a focused desktop Tag dialog from the existing list/session data, and let the current setting updater persist deletion through `removeSidebarTag`. Reuse `CompactSessionRow`, `DesktopDialogFrame`, translations, and semantic theme tokens.

**Tech Stack:** React Native Web, Expo Router, TypeScript, Unistyles, Vitest, react-test-renderer.

**Spec:** `docs/design/pc-tag-list-groups.md`

## Follow-up: archived Tag sessions

- [x] Add a final `archived` group to `buildSidebarTagSessionGroups`; archived sessions never remain inside their previous List group.
- [x] Build Tag details from the complete session data source while leaving ordinary sidebar Lists on the visible-only source.
- [x] Add device-local `tagDetailsHideArchived`, defaulting to showing archived sessions and independent from the main List view.
- [x] Move archive visibility and Delete Tag into the Tag detail header menu; close the menu before either action continues.
- [x] Cover archive ordering, total counts, setting persistence, menu behavior, and delete handoff with model/component tests.
- [x] Keep association totals stable across paginated history and explain partial/not-yet-loaded historical rows without presenting a false empty state.
- [x] Remove synced List/Tag assignments when a session is permanently deleted so stable totals cannot become ghost counts.

## Global Constraints

- Work only in `/Users/jacky/jacky-github/happy--pc-tag-list-groups`; root `main` remains clean and equal to `origin/main`.
- All new user-visible strings use `t(...)` and exist in every file under `sources/text/translations/`.
- All visible colors use `theme.colors.*`; no hard-coded component surface colors.
- Tauri is out of scope.
- Production code follows a witnessed RED → GREEN test cycle.

---

### Task 1: Tag-to-list grouping model

**Files:**
- Modify: `packages/happy-app/sources/sync/sidebarOrganization.ts`
- Test: `packages/happy-app/sources/sync/sidebarOrganization.test.ts`

**Interfaces:**
- Consumes: `SidebarOrganization['lists']`, `SidebarOrganization['sessions']`, visible `{ id: string }` session records, and a `tagId`.
- Produces: `buildSidebarTagSessionGroups<T>(sessions, organization, tagId): SidebarTagSessionGroup<T>[]`, where each group has `id`, `list`, and `sessions`.

- [x] **Step 1: Write the failing grouping tests**

```ts
const groups = buildSidebarTagSessionGroups(
    [{ id: 's-unassigned' }, { id: 's-happy' }, { id: 's-other' }],
    {
        ...organization,
        sessions: {
            's-unassigned': { listId: null, tagIds: ['product'] },
            's-happy': { listId: 'workspace', tagIds: ['product'] },
            's-other': { listId: 'advisor', tagIds: ['research'] },
        },
    },
    'product',
);
expect(groups.map((group) => [group.id, group.sessions.map((session) => session.id)])).toEqual([
    ['workspace', ['s-happy']],
    ['unassigned', ['s-unassigned']],
]);
```

- [x] **Step 2: Run the focused model test and verify RED**

Run: `pnpm --filter happy-app exec vitest run sources/sync/sidebarOrganization.test.ts`

Expected: FAIL because `buildSidebarTagSessionGroups` is not exported.

- [x] **Step 3: Implement the minimal one-pass grouping function**

```ts
export type SidebarTagSessionGroup<T extends { id: string }> = {
    id: string;
    list: SidebarList | null;
    sessions: T[];
};

export function buildSidebarTagSessionGroups<T extends { id: string }>(
    sessions: readonly T[],
    organization: SidebarOrganization,
    tagId: string,
): SidebarTagSessionGroup<T>[];
```

The function emits non-empty known lists in stored order, then one `unassigned` group for null or unknown list references.

- [x] **Step 4: Run the model test and verify GREEN**

Run: `pnpm --filter happy-app exec vitest run sources/sync/sidebarOrganization.test.ts`

Expected: all model tests pass.

### Task 2: Tag detail and delete interaction

**Files:**
- Create: `packages/happy-app/sources/components/DesktopTagDialog.tsx`
- Modify: `packages/happy-app/sources/components/DesktopDialogFrame.tsx`
- Modify: `packages/happy-app/sources/components/DesktopSidebarSessionsNavigation.tsx`
- Test: `packages/happy-app/sources/components/DesktopSidebarSessionsNavigation.test.tsx`

**Interfaces:**
- Consumes: selected `SidebarTag`, grouped `SessionRowData`, selected session id, and callbacks for close/delete.
- Produces: `DesktopTagDetailDialog` and `DesktopTagActionsPopover`; `DesktopDialogFrame` accepts optional `maxWidth` and `testID`.

- [x] **Step 1: Write failing component tests for C1-C4**

```ts
act(() => renderer.root.findByProps({ testID: 'sidebar-tag-product' }).props.onPress());
expect(renderer.root.findByProps({ testID: 'tag-detail-dialog-product' })).toBeDefined();
expect(renderer.root.findAllByProps({ testID: 'tag-detail-group-happy' })).toHaveLength(1);
expect(renderer.root.findAllByProps({ testID: 'sidebar-close-tag-filter' })).toHaveLength(0);
```

Add a separate delete test that opens `sidebar-tag-menu-product`, confirms `sidebar-delete-tag-product`, applies the captured setting updater, and asserts that the Tag and `tagIds` reference disappear while the session and its `listId` remain.

- [x] **Step 2: Run the focused component test and verify RED**

Run: `pnpm --filter happy-app exec vitest run sources/components/DesktopSidebarSessionsNavigation.test.tsx`

Expected: FAIL because the dialog/group/menu test IDs and interactions do not exist.

- [x] **Step 3: Implement the minimal dialog, row, menu, and deletion wiring**

```tsx
<DesktopTagDetailDialog
    groups={selectedTagGroups}
    onClose={() => setSelectedTagId(null)}
    onDelete={() => void deleteTag(selectedTag)}
    selectedSessionId={selectedSessionId}
    tag={selectedTag}
/>
```

Tag rows use a full-width main press target plus a separate `more-horizontal` button. The actions popover contains the destructive delete action. `deleteTag` uses `Modal.confirm`, calls `removeSidebarTag`, and clears dialog/menu state only after confirmation.

- [x] **Step 4: Run the focused component test and verify GREEN**

Run: `pnpm --filter happy-app exec vitest run sources/components/DesktopSidebarSessionsNavigation.test.tsx`

Expected: all component tests pass.

### Task 3: Localized copy and full static verification

**Files:**
- Modify: `packages/happy-app/sources/text/_default.ts`
- Modify: `packages/happy-app/sources/text/translations/{en,ru,pl,es,ca,it,pt,ja,zh-Hans,zh-Hant}.ts`

**Interfaces:**
- Produces: `sidebarLists.tagActions`, `sidebarLists.tagDetailsMeta`, `sidebarLists.groupedByList`, `sidebarLists.deleteTag`, and `sidebarLists.deleteTagConfirm` in the default contract and every locale.

- [x] **Step 1: Add every translation key to all locale files**

English and Simplified/Traditional Chinese receive native copy; existing repository convention permits English fallback copy for the remaining locales in this focused change.

- [x] **Step 2: Run focused tests, typecheck, and lint-equivalent checks**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/sync/sidebarOrganization.test.ts sources/components/DesktopSidebarSessionsNavigation.test.tsx
pnpm --filter happy-app typecheck
```

Result: focused tests pass. TypeScript still reports the branch baseline's generated Expo Router route errors; no new error points to the Tag dialog, grouping model, translations, or shared dialog changes.

### Task 4: Real PC Web interaction acceptance

**Files:**
- No production files; produce browser evidence and an E2E recording artifact.

**Interfaces:**
- Consumes: the local Happy Web build and authenticated development state.
- Produces: one-to-one results for C1-C4 and verified Ego browser steps. Real account data must not be mutated only to manufacture evidence.

- [x] **Step 1: Start the real Happy Web development server**

Run: `pnpm --filter happy-app exec expo start --web --port 8081`

- [x] **Step 2: Use Ego to verify C1-C4 on the real rendered page**

Check the full-width Tag rows, selected state, 720px detail dialog, ordered collapsible groups, and confirmation copy. If the real account has no populated Tag, verify the populated grouping and post-delete preservation through the component/model regression fixtures rather than changing the user's data.

- [x] **Step 3: Run an independent diff/interaction review and fix only confirmed issues**

The reviewer returns `pass`, `fail`, or `blocked` for each Case with concrete evidence.

- [x] **Step 4: Re-run focused tests and typecheck after any review fix**

Result: 37 focused tests pass. The independent reviewer found no Critical issue; its two Important findings were fixed and covered by regression tests. TypeScript retains only the known generated-route baseline failures described above.
