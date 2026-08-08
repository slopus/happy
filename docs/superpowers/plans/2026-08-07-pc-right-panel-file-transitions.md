# Happy PC/Web Right Panel and File Transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consistent, directional Presence transitions to the PC/Web right-panel tabs, file-sidebar tabs, and Chat/Diff/File workspace history without remounting the chat tree.

**Architecture:** Introduce a platform-paired `DesktopPresenceTransition` component that keeps at most one outgoing and one incoming layer for 150ms, with CSS driven by phase and direction data attributes. Integrate that host at the three conditional-render boundaries while keeping navigation state, headers, panel dimensions, and data loading unchanged; native receives a passthrough implementation.

**Tech Stack:** React 19, React Native Web, Expo, TypeScript, Vitest with `react-test-renderer`, CSS transitions in `theme.css`, Playwright Chromium E2E.

## Global Constraints

- Implement only in `/Users/jacky/jacky-github/happy--pc-motion-polish` on branch `feat/pc-motion-polish`; do not edit the root `main` worktree.
- The approved design is `docs/superpowers/specs/2026-08-07-pc-right-panel-file-transitions-design.md` at commit `1e075e28`.
- Content transitions use exactly 150ms, 8px horizontal translation, opacity, and transform; do not animate width, height, row geometry, or scroll position.
- Enter easing is `cubic-bezier(0.22, 1, 0.36, 1)` and exit easing is `cubic-bezier(0.4, 0, 1, 1)`.
- Tab background, text, and icon colors transition for exactly 120ms.
- The right-panel and file-tab content Presence Hosts have exactly two layers during content-to-content transitions and one settled layer at rest.
- The workspace Presence Host contains only Diff/File overlays: Chat → Diff/File has one incoming intermediate layer and one settled layer; Diff ↔ File has one outgoing plus one incoming intermediate layer and one settled layer; Diff/File → Chat has one outgoing intermediate layer and zero settled layers.
- An outgoing layer becomes pointer-disabled and hidden from the accessibility tree in the same React commit that starts its visual exit.
- `prefers-reduced-motion: reduce` replaces content immediately and leaves no timer, animation frame, or overlapping layer.
- Chat remains mounted beneath Diff/File overlays; no implementation may clone the chat subtree.
- Native and mobile behavior remains unchanged through the non-Web passthrough component.
- No new runtime dependency is allowed.
- E2E acceptance covers `PC-MOTION-06`, `PC-MOTION-07`, and `PC-MOTION-08` at 1280×720 and 1920×1080 with zero unexpected console errors, page errors, or failed requests.
- Use exact-path `git add` commands in every task because this worktree begins with verified, uncommitted motion changes.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/happy-app/sources/components/DesktopPresenceTransition.types.ts` | Shared public direction and props contract for both platform implementations. |
| `packages/happy-app/sources/components/DesktopPresenceTransition.tsx` | Native/mobile passthrough that renders only current children. |
| `packages/happy-app/sources/components/DesktopPresenceTransition.test.tsx` | Verifies the native/mobile implementation introduces no host or retained layer. |
| `packages/happy-app/sources/components/DesktopPresenceTransition.web.tsx` | Web-only two-layer lifecycle, reduced-motion subscription, cleanup, and accessibility isolation. |
| `packages/happy-app/sources/components/DesktopPresenceTransition.web.test.tsx` | Focused lifecycle, rapid-switching, null-content, accessibility, and reduced-motion tests. |
| `packages/happy-app/sources/components/DesktopRightPanel.tsx` | Adds stable tab motion attributes while keeping current layout and semantics. |
| `packages/happy-app/sources/components/FilesSidebar.tsx` | Applies the shared host to Changes/All Files and adds tab motion attributes. |
| `packages/happy-app/sources/components/FilesSidebar.test.tsx` | Verifies controlled tab direction, semantics, and selected-state attributes. |
| `packages/happy-app/sources/-session/SessionView.tsx` | Applies Presence to Capabilities/Files and the Chat/Diff/File overlay history. |
| `packages/happy-app/sources/-session/SessionView.agentSpace.test.tsx` | Verifies primary-tab direction, overlay push/back/forward direction, and forced reset. |
| `packages/happy-app/sources/theme.css` | Defines 150ms Presence phases, 120ms tab colors, and reduced-motion overrides. |
| `packages/happy-app/e2e/pc-motion-polish-evidence.spec.ts` | Captures before/after motion evidence and runtime error deltas for Cases 06–08. |

---

### Task 1: Checkpoint the Verified PC Motion Baseline

**Files:**
- Verify: `packages/happy-app/e2e/web-compose-home.spec.ts`
- Verify: `packages/happy-app/e2e/pc-motion-polish-evidence.spec.ts`
- Verify: `packages/happy-app/sources/-session/SessionView.agentSpace.test.tsx`
- Verify: `packages/happy-app/sources/-session/SessionView.tsx`
- Verify: `packages/happy-app/sources/components/CommandPalette/CommandPaletteModal.tsx`
- Verify: `packages/happy-app/sources/components/ComposeHome.tsx`
- Verify: `packages/happy-app/sources/components/ComposeHomeParticles.web.tsx`
- Verify: `packages/happy-app/sources/components/SessionActionsPopover.tsx`
- Verify: `packages/happy-app/sources/components/SessionInfoDropdown.tsx`
- Verify: `packages/happy-app/sources/components/Shaker.web.tsx`
- Verify: `packages/happy-app/sources/components/Shaker.web.test.tsx`
- Verify: `packages/happy-app/sources/components/SidebarNavigator.tsx`
- Verify: `packages/happy-app/sources/components/SidebarNavigator.test.tsx`
- Verify: `packages/happy-app/sources/hooks/useDesktopWorkspaceLayout.tsx`
- Verify: `packages/happy-app/sources/modal/components/CustomModal.tsx`
- Verify: `packages/happy-app/sources/modal/components/CustomModal.test.tsx`
- Verify: `packages/happy-app/sources/theme.css`

**Interfaces:**
- Consumes: The already-validated uncommitted PC motion changes for Cases `PC-MOTION-01` through `PC-MOTION-05`.
- Produces: A clean feature worktree where subsequent exact-file commits cannot accidentally absorb earlier work.

- [ ] **Step 1: Confirm the dirty tree contains only the known baseline paths**

Run:

```bash
git status --short
git diff --check
```

Expected: the paths are exactly the files listed above; `git diff --check` exits 0.

- [ ] **Step 2: Re-run the focused baseline tests**

Run:

```bash
pnpm --filter happy-app exec vitest run \
  sources/components/Shaker.web.test.tsx \
  sources/components/SidebarNavigator.test.tsx \
  sources/modal/components/CustomModal.test.tsx \
  sources/-session/SessionView.agentSpace.test.tsx
```

Expected: all listed test files pass with zero retries.

- [ ] **Step 3: Re-run the app typecheck**

Run:

```bash
pnpm --filter happy-app typecheck
```

Expected: exit code 0 and no TypeScript diagnostic.

- [ ] **Step 4: Stage only the verified baseline**

Run:

```bash
git add -- \
  packages/happy-app/e2e/web-compose-home.spec.ts \
  packages/happy-app/e2e/pc-motion-polish-evidence.spec.ts \
  packages/happy-app/sources/-session/SessionView.agentSpace.test.tsx \
  packages/happy-app/sources/-session/SessionView.tsx \
  packages/happy-app/sources/components/CommandPalette/CommandPaletteModal.tsx \
  packages/happy-app/sources/components/ComposeHome.tsx \
  packages/happy-app/sources/components/ComposeHomeParticles.web.tsx \
  packages/happy-app/sources/components/SessionActionsPopover.tsx \
  packages/happy-app/sources/components/SessionInfoDropdown.tsx \
  packages/happy-app/sources/components/Shaker.web.tsx \
  packages/happy-app/sources/components/Shaker.web.test.tsx \
  packages/happy-app/sources/components/SidebarNavigator.tsx \
  packages/happy-app/sources/components/SidebarNavigator.test.tsx \
  packages/happy-app/sources/hooks/useDesktopWorkspaceLayout.tsx \
  packages/happy-app/sources/modal/components/CustomModal.tsx \
  packages/happy-app/sources/modal/components/CustomModal.test.tsx \
  packages/happy-app/sources/theme.css
git diff --cached --check
git diff --cached --name-only
```

Expected: the cached name list contains the 17 paths in this task and no design or plan document.

- [ ] **Step 5: Commit the baseline**

Run:

```bash
git commit -m "feat(app): polish PC motion interactions"
git status --short
```

Expected: the commit succeeds and the feature worktree is clean.

---

### Task 2: Extend the Visual Harness and Capture Cases 06–08 Before Evidence

**Files:**
- Modify: `packages/happy-app/e2e/pc-motion-polish-evidence.spec.ts:1-390`

**Interfaces:**
- Consumes: Existing authenticated E2E environment variables, the session-scoped Socket.IO RPC pattern used in `web-compose-home.spec.ts`, and current tab/navigation test IDs.
- Produces: `enableFileDiffsSidebar(page)`, a connected two-file session fixture, `readPresenceLayers(page, hostTestId)`, a file-transition phase independent from Cases 01–05, and baseline evidence for `PC-MOTION-06` through `PC-MOTION-08`.

- [ ] **Step 1: Add the connected file-session fixture**

Add imports for `mkdirSync`, `mkdtempSync`, `rmSync`, `tmpdir`, Socket.IO client, `decodeBase64`, and `decryptLegacy`. Create a fixture that writes these exact files:

```ts
const workspace = mkdtempSync(join(tmpdir(), 'happy-file-motion-e2e-'));
const changedFile = 'src/changed-motion.ts';
const secondFile = 'src/second-motion.ts';
mkdirSync(join(workspace, 'src'), { recursive: true });
writeFileSync(join(workspace, changedFile), 'export const changedMotion = true;\n', 'utf8');
writeFileSync(join(workspace, secondFile), 'export const secondMotion = true;\n', 'utf8');
const bashReplies = (command: string) => {
    if (command.includes('status --porcelain=v2')) {
        return '# branch.head main\n? src/changed-motion.ts\n';
    }
    if (command.includes('diff --numstat')) {
        return '1\t0\tsrc/changed-motion.ts\n---STAGED---\n';
    }
    if (command.includes('ls-files')) {
        return `${changedFile}\n${secondFile}\n`;
    }
    return '';
};
```

Register `${sessionId}:bash` and `${sessionId}:readFile`; return encrypted `{ success: true, stdout, stderr: '', exitCode: 0 }` for bash and base64 file content for readFile. Return a `close()` method that closes the socket and removes the temporary workspace.

- [ ] **Step 2: Add reusable UI and motion readers**

Add these contracts and implement them without time-based polling outside the reader:

```ts
const fileTransitionPhase = process.env.HAPPY_PC_FILE_TRANSITION_PHASE === 'after' ? 'after' : 'before';
const isFileTransitionAfter = fileTransitionPhase === 'after';

type PresenceLayerReading = {
    direction: string | null;
    opacity: string;
    phase: string | null;
    pointerEvents: string;
    transform: string;
};

async function enableFileDiffsSidebar(page: Page): Promise<void> {
    await page.goto(authenticatedRoute('/settings/features'));
    const toggle = page.getByRole('switch', { name: 'File Diffs Sidebar' });
    await expect(toggle).toBeVisible();
    if (!await toggle.isChecked()) await toggle.click();
    await expect(toggle).toBeChecked();
}

async function readPresenceLayers(page: Page, hostTestId: string): Promise<PresenceLayerReading[]> {
    return page.locator(`[data-testid="${hostTestId}"] [data-happy-presence-phase]`).evaluateAll((layers) => (
        layers.map((layer) => {
            const style = getComputedStyle(layer);
            return {
                direction: layer.getAttribute('data-happy-presence-direction'),
                opacity: style.opacity,
                phase: layer.getAttribute('data-happy-presence-phase'),
                pointerEvents: style.pointerEvents,
                transform: style.transform,
            };
        })
    ));
}
```

- [ ] **Step 3: Add baseline/after-aware Cases 06–08**

For each viewport in `[{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]`, perform this exact route through the UI:

```ts
await enableFileDiffsSidebar(page);
await page.goto(authenticatedRoute(`/session/${fixture.sessionId}`));
const rightPanel = page.getByTestId('desktop-right-panel');

await rightPanel.getByTestId('desktop-right-panel-files-tab').click();
await expect(rightPanel.getByTestId('session-files-sidebar')).toBeVisible();

await rightPanel.getByTestId('session-files-all-tab').click();
await expect(rightPanel.getByPlaceholder('Search files...')).toBeVisible();
await rightPanel.getByText('second-motion.ts', { exact: true }).click();
if (isFileTransitionAfter) {
    await expect(page.getByTestId('workspace-file-panel')).toBeVisible();
} else {
    await expect(page.getByTestId('desktop-workspace-main').getByText('second-motion.ts', { exact: true })).toBeVisible();
}

await page.getByTestId('desktop-navigation-back-button').click();
await page.getByTestId('desktop-navigation-forward-button').click();
await rightPanel.getByTestId('session-files-changes-tab').click();
await rightPanel.getByText('changed-motion.ts', { exact: true }).click();
if (isFileTransitionAfter) {
    await expect(page.getByTestId('workspace-diff-panel')).toBeVisible();
} else {
    await expect(page.getByTestId('desktop-workspace-main').getByText('src/changed-motion.ts', { exact: true })).toBeVisible();
}
```

For each click, read layers after 40ms and again after 220ms. In file-transition before mode assert no Presence layer attributes. In file-transition after mode, right-panel and file-tab content-to-content transitions have exactly two intermediate layers (one exiting with pointer events `none`) and one settled layer. The workspace overlay Host follows the approved non-cloning contract: Chat → Diff/File has one intermediate layer, zero exiting layers, and one settled layer; Diff ↔ File has two intermediate layers, exactly one pointer-disabled exiting layer, and one settled layer; Diff/File → Chat has one intermediate exiting layer with pointer events `none` and zero settled layers. Chat stays mounted below the workspace overlay Host and is never one of its Presence layers. Assert forward/back directions are opposite. Focus each source tab before pressing Enter and assert `document.activeElement` remains that tab after the content key changes. Add a rapid `files → capabilities → files` and `allFiles → changes → allFiles` sequence with 30ms between clicks and assert the sampled layer count never exceeds 2. Run the same sequence under `page.emulateMedia({ reducedMotion: 'reduce' })` and assert no layer has phase `entering` or `exiting`. Read computed tab styles in after mode and assert a `0.12s` transition duration constrained to `background-color` and/or `color`, never `all`, `width`, or `height`.

Use `fileTransitionPhase`, not the older `evidencePhase`, in every Case 06–08 screenshot filename and in the Case 06–08 JSON subtree. Record both `motionPhase: evidencePhase` and `fileTransitionPhase` at the result root so the baseline run is unambiguous.

- [ ] **Step 4: Capture baseline evidence before production changes**

Run:

```bash
mkdir -p /tmp/happy-pc-motion-evidence/before
HAPPY_PC_MOTION_EVIDENCE_PHASE=after \
HAPPY_PC_FILE_TRANSITION_PHASE=before \
HAPPY_PC_MOTION_EVIDENCE_DIR=/tmp/happy-pc-motion-evidence/before \
pnpm test:e2e:web -- pc-motion-polish-evidence.spec.ts
```

Cases 01–05 use `after` because they are already implemented at this branch point, while only the independent `HAPPY_PC_FILE_TRANSITION_PHASE` is `before`. Expected: the E2E passes and writes Case 06–08 before PNG/JSON/video evidence for both viewports. The JSON records zero unexpected console errors, page errors, and failed requests.

- [ ] **Step 5: Commit the E2E harness**

Run:

```bash
git add -- packages/happy-app/e2e/pc-motion-polish-evidence.spec.ts
git diff --cached --check
git commit -m "test(app): cover PC file transitions"
```

Expected: one test-only commit; `/tmp/happy-pc-motion-evidence` remains outside Git.

---

### Task 3: Build the Shared Web Presence Host

**Files:**
- Create: `packages/happy-app/sources/components/DesktopPresenceTransition.types.ts`
- Create: `packages/happy-app/sources/components/DesktopPresenceTransition.tsx`
- Create: `packages/happy-app/sources/components/DesktopPresenceTransition.test.tsx`
- Create: `packages/happy-app/sources/components/DesktopPresenceTransition.web.tsx`
- Create: `packages/happy-app/sources/components/DesktopPresenceTransition.web.test.tsx`
- Modify: `packages/happy-app/sources/theme.css:13-116`

**Interfaces:**
- Consumes: React children, a stable transition key, direction, optional immediate reset, and a test ID.
- Produces: `DesktopPresenceTransition`, `DesktopTransitionDirection`, and `DesktopPresenceTransitionProps` with this exact contract:

```ts
export type DesktopTransitionDirection = 'forward' | 'back';

export type DesktopPresenceTransitionProps = {
    children: React.ReactNode | null;
    direction: DesktopTransitionDirection;
    immediate?: boolean;
    testID: string;
    transitionKey: string;
};
```

- [ ] **Step 1: Write the failing lifecycle tests**

Create `DesktopPresenceTransition.web.test.tsx` with fake timers, a `requestAnimationFrame` backed by `setTimeout(..., 16)`, a mutable `matchMedia().matches`, and a React Native `View` mock. Cover these assertions:

```ts
let renderer: any;
act(() => {
    renderer = TestRenderer.create(
        <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
            <View testID="capabilities-content" />
        </DesktopPresenceTransition>,
    );
});
expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);

act(() => renderer.update(
    <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
        <View testID="files-content" />
    </DesktopPresenceTransition>,
));
const transitionLayers = renderer.root.findAllByProps({ testID: 'presence-layer' });
expect(transitionLayers).toHaveLength(2);
expect(transitionLayers.find((layer: any) => layer.props.dataSet.happyPresencePhase === 'exiting')?.props).toMatchObject({
    'aria-hidden': true,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
    pointerEvents: 'none',
});

act(() => vi.advanceTimersByTime(220));
expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet).toMatchObject({
    happyPresenceDirection: 'forward',
    happyPresencePhase: 'settled',
});
```

Add the rapid-switch and immediate assertions with this sequence:

```ts
act(() => renderer.update(
    <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
        <View testID="files-content" />
    </DesktopPresenceTransition>,
));
act(() => vi.advanceTimersByTime(30));
act(() => renderer.update(
    <DesktopPresenceTransition direction="back" testID="presence" transitionKey="capabilities">
        <View testID="capabilities-content-next" />
    </DesktopPresenceTransition>,
));
expect(renderer.root.findAllByProps({ testID: 'presence-layer' }).length).toBeLessThanOrEqual(2);
act(() => vi.advanceTimersByTime(220));
expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);

act(() => renderer.update(
    <DesktopPresenceTransition direction="forward" immediate testID="presence" transitionKey="files">
        <View testID="files-immediate" />
    </DesktopPresenceTransition>,
));
expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet.happyPresencePhase).toBe('settled');
```

Add a null-content and reduced-motion test using these state changes:

```tsx
act(() => renderer.update(
    <DesktopPresenceTransition direction="back" testID="presence" transitionKey="chat">
        {null}
    </DesktopPresenceTransition>,
));
expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet.happyPresencePhase).toBe('exiting');
act(() => vi.advanceTimersByTime(220));
expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(0);

mediaQuery.matches = true;
act(() => mediaQuery.dispatch(true));
act(() => renderer.update(
    <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="file:src/a.ts">
        <View testID="file-content" />
    </DesktopPresenceTransition>,
));
expect(renderer.root.findAllByProps({ testID: 'presence-layer' })).toHaveLength(1);
expect(renderer.root.findByProps({ testID: 'presence-layer' }).props.dataSet.happyPresencePhase).toBe('settled');
```

The media-query mock's `dispatch(matches)` calls its registered listener with `{ matches }`. After unmount, assert the listener set is empty and `vi.getTimerCount()` is 0.

- [ ] **Step 2: Run the test and verify the component is missing**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/components/DesktopPresenceTransition.web.test.tsx
```

Expected: FAIL because `DesktopPresenceTransition.web` does not exist.

- [ ] **Step 3: Write and run the native passthrough test**

Create `DesktopPresenceTransition.test.tsx` with this direct contract:

```tsx
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { DesktopPresenceTransition } from './DesktopPresenceTransition';

describe('DesktopPresenceTransition native passthrough', () => {
    it('renders only the current child without a retained host', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <DesktopPresenceTransition direction="forward" testID="presence" transitionKey="files">
                    {React.createElement('CurrentChild', { testID: 'current-child' })}
                </DesktopPresenceTransition>,
            );
        });
        expect(renderer.root.findAllByProps({ testID: 'current-child' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'presence' })).toHaveLength(0);
        act(() => renderer.unmount());
    });
});
```

Run:

```bash
pnpm --filter happy-app exec vitest run sources/components/DesktopPresenceTransition.test.tsx
```

Expected: FAIL because the native passthrough does not exist.

- [ ] **Step 4: Add shared types and the native passthrough**

Create the shared type file with the interface above. Create the native implementation:

```tsx
import * as React from 'react';
import type { DesktopPresenceTransitionProps } from './DesktopPresenceTransition.types';

export type { DesktopPresenceTransitionProps, DesktopTransitionDirection } from './DesktopPresenceTransition.types';

export function DesktopPresenceTransition({ children }: DesktopPresenceTransitionProps) {
    return <>{children}</>;
}
```

- [ ] **Step 5: Implement the two-layer Web lifecycle**

The Web module must import the shared props type and re-export both public types so platform resolution presents the same module surface as the native file.

Use these exact internal types and constants:

```ts
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TRANSITION_FALLBACK_MS = 190;

type PresencePhase = 'entering' | 'active' | 'exiting' | 'settled';
type PresenceLayer = {
    direction: DesktopTransitionDirection;
    id: number;
    key: string;
    node: React.ReactNode;
    phase: PresencePhase;
};
```

Initialize `layers` from the first render so non-null children start as one `settled` layer and null starts as an empty array:

```ts
const sequenceRef = React.useRef(0);
const [layers, setLayers] = React.useState<PresenceLayer[]>(() => children === null ? [] : [{
    direction,
    id: 0,
    key: transitionKey,
    node: children,
    phase: 'settled',
}]);
```

The key-change layout effect must perform this state transition:

```ts
const nextId = ++sequenceRef.current;
const active = previous.find((layer) => layer.phase !== 'exiting');
const outgoing = active ? [{ ...active, direction, phase: 'exiting' as const }] : [];
const incoming = children === null ? [] : [{
    direction,
    id: nextId,
    key: transitionKey,
    node: children,
    phase: 'entering' as const,
}];
return [...outgoing, ...incoming];
```

On the next animation frame, change only the new layer from `entering` to `active`. On an opacity `transitionend` or the 190ms fallback, remove every `exiting` layer and change the matching `active` layer to `settled`. Guard both callbacks with the current sequence number. On a third key during transition, derive outgoing only from the latest non-exiting layer and discard the older outgoing layer. When the key is unchanged, replace the active layer's `node` without starting a transition. When `immediate` changes to true, synchronously keep only the latest child as one `settled` layer and cancel pending work.

Render layers with:

```tsx
<View pointerEvents="box-none" style={styles.host} testID={testID}>
    {layers.map((layer) => {
        const exiting = layer.phase === 'exiting';
        return (
            <View
                aria-hidden={exiting}
                accessibilityElementsHidden={exiting}
                dataSet={{
                    happyMotion: 'desktop-presence-layer',
                    happyPresenceDirection: layer.direction,
                    happyPresencePhase: layer.phase,
                }}
                importantForAccessibility={exiting ? 'no-hide-descendants' : 'auto'}
                key={layer.id}
                pointerEvents={exiting ? 'none' : 'auto'}
                style={styles.layer}
                testID="presence-layer"
            >
                {layer.node}
            </View>
        );
    })}
</View>
```

Define the host/layer geometry without clipping focus rings or scrollbars:

```ts
const styles = StyleSheet.create({
    host: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
    },
    layer: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
    },
});
```

The reduced-motion media query must subscribe with `addEventListener('change', listener)` and remove the same listener on unmount. When reduce becomes true, synchronously keep only the latest current child as a `settled` layer and cancel the pending frame and fallback timer.

- [ ] **Step 6: Add the CSS motion contract**

Append the four variables to the existing `:root` block in `theme.css`; do not create a second root block. Add the selectors after the existing desktop-panel rules:

```css
:root {
    --happy-motion-content-duration: 150ms;
    --happy-motion-tab-duration: 120ms;
    --happy-motion-content-ease-in: cubic-bezier(0.4, 0, 1, 1);
    --happy-motion-content-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
}

[data-happy-motion="desktop-presence-layer"] {
    opacity: 1;
    transform: translate3d(0, 0, 0);
    transition:
        opacity var(--happy-motion-content-duration) var(--happy-motion-content-ease-out),
        transform var(--happy-motion-content-duration) var(--happy-motion-content-ease-out);
}

[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="entering"],
[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="active"],
[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="exiting"] {
    will-change: opacity, transform;
}

[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="settled"] {
    will-change: auto;
}

[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="entering"][data-happy-presence-direction="forward"] {
    opacity: 0;
    transform: translate3d(8px, 0, 0);
}

[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="entering"][data-happy-presence-direction="back"] {
    opacity: 0;
    transform: translate3d(-8px, 0, 0);
}

[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="exiting"] {
    transition-timing-function: var(--happy-motion-content-ease-in);
}

[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="exiting"][data-happy-presence-direction="forward"] {
    opacity: 0;
    transform: translate3d(-8px, 0, 0);
}

[data-happy-motion="desktop-presence-layer"][data-happy-presence-phase="exiting"][data-happy-presence-direction="back"] {
    opacity: 0;
    transform: translate3d(8px, 0, 0);
}
```

Inside the existing reduced-motion media query, set transition to none, transform to none, and `will-change: auto` for desktop Presence layers.

- [ ] **Step 7: Run the focused tests and typecheck**

Run:

```bash
pnpm --filter happy-app exec vitest run \
  sources/components/DesktopPresenceTransition.test.tsx \
  sources/components/DesktopPresenceTransition.web.test.tsx
pnpm --filter happy-app typecheck
```

Expected: all Presence tests pass and typecheck exits 0.

- [ ] **Step 8: Commit the Presence primitive**

Run:

```bash
git add -- \
  packages/happy-app/sources/components/DesktopPresenceTransition.types.ts \
  packages/happy-app/sources/components/DesktopPresenceTransition.tsx \
  packages/happy-app/sources/components/DesktopPresenceTransition.test.tsx \
  packages/happy-app/sources/components/DesktopPresenceTransition.web.tsx \
  packages/happy-app/sources/components/DesktopPresenceTransition.web.test.tsx \
  packages/happy-app/sources/theme.css
git diff --cached --check
git commit -m "feat(app): add desktop presence transitions"
```

Expected: the primitive and its CSS/tests land in one commit.

---

### Task 4: Animate the Right-Panel and File-Sidebar Tabs

**Files:**
- Modify: `packages/happy-app/sources/components/DesktopRightPanel.tsx:1-115`
- Modify: `packages/happy-app/sources/components/FilesSidebar.tsx:1-290`
- Create: `packages/happy-app/sources/components/FilesSidebar.test.tsx`
- Modify: `packages/happy-app/sources/-session/SessionView.tsx:1-50,347-354,782-809`
- Modify: `packages/happy-app/sources/-session/SessionView.agentSpace.test.tsx:1-190,420-450`
- Modify: `packages/happy-app/sources/theme.css:13-150`

**Interfaces:**
- Consumes: `DesktopPresenceTransitionProps` from Task 3.
- Produces: `desktop-right-panel-content-transition` and `session-files-mode-transition` hosts plus `data-happy-motion="desktop-tab"` on both tab sets.

- [ ] **Step 1: Write failing controlled-tab tests**

In `SessionView.agentSpace.test.tsx`, mock the platform module as a transparent named host:

```tsx
vi.mock('@/components/DesktopPresenceTransition', async () => {
    const ReactModule = await import('react');
    return {
        DesktopPresenceTransition: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
            ReactModule.createElement('DesktopPresenceTransition', props, children)
        ),
    };
});
```

Extend the wide-desktop test with these assertions:

```ts
expect(renderer.root.findByProps({ testID: 'desktop-right-panel-content-transition' }).props).toMatchObject({
    direction: 'back',
    transitionKey: 'capabilities',
});
const filesTab = renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' });
expect(filesTab.props.accessibilityRole).toBe('tab');
expect(filesTab.props.dataSet).toMatchObject({ happyMotion: 'desktop-tab', happyMotionState: 'idle' });
act(() => filesTab.props.onPress());
expect(renderer.root.findByProps({ testID: 'desktop-right-panel-content-transition' }).props).toMatchObject({
    direction: 'forward',
    transitionKey: 'files',
});
```

Create `FilesSidebar.test.tsx` with mocked storage/sync functions and a controlled wrapper. Click `session-files-all-tab`, then `session-files-changes-tab`; assert transition keys `allFiles` then `changes`, directions `forward` then `back`, exactly one selected `tab` semantic, and selected/idle data attributes on both buttons.

Use this controlled interaction as the core of the test:

```tsx
function FilesSidebarHarness() {
    const [mode, setMode] = React.useState<SidebarMode>('changes');
    return (
        <FilesSidebar
            mode={mode}
            onAllFilesFilePress={vi.fn()}
            onFilePress={vi.fn()}
            onModeChange={setMode}
            sessionId="session-1"
        />
    );
}

act(() => { renderer = TestRenderer.create(<FilesSidebarHarness />); });
expect(renderer.root.findByType('DesktopPresenceTransition').props).toMatchObject({
    direction: 'back',
    transitionKey: 'changes',
});
act(() => renderer.root.findByProps({ testID: 'session-files-all-tab' }).props.onPress());
expect(renderer.root.findByType('DesktopPresenceTransition').props).toMatchObject({
    direction: 'forward',
    transitionKey: 'allFiles',
});
expect(renderer.root.findByProps({ testID: 'session-files-all-tab' }).props.accessibilityState).toEqual({ selected: true });
act(() => renderer.root.findByProps({ testID: 'session-files-changes-tab' }).props.onPress());
expect(renderer.root.findByType('DesktopPresenceTransition').props.direction).toBe('back');
```

- [ ] **Step 2: Run the tests and verify the missing hosts**

Run:

```bash
pnpm --filter happy-app exec vitest run \
  sources/components/FilesSidebar.test.tsx \
  sources/-session/SessionView.agentSpace.test.tsx
```

Expected: FAIL because neither conditional content boundary uses `DesktopPresenceTransition` and the tab motion attributes do not exist.

- [ ] **Step 3: Add the shared tab data attributes**

Import `Platform` in `DesktopRightPanel.tsx` and add this prop to each tab `Pressable`:

```tsx
{...(Platform.OS === 'web' ? {
    dataSet: {
        happyMotion: 'desktop-tab',
        happyMotionState: selected ? 'selected' : 'idle',
    },
} as any : {})}
```

Apply the same Web-only attributes to the Changes and All Files `Pressable` elements in `FilesSidebar.tsx`, using their existing `mode` comparisons.

Also add `accessibilityRole="tab"` to both file-sidebar buttons. Set `accessibilityState={{ selected: mode === 'changes' }}` on the Changes button and `accessibilityState={{ selected: mode === 'allFiles' }}` on the All Files button. The current mode must be the only tab with `selected: true`.

- [ ] **Step 4: Wrap right-panel primary content**

In `SessionView.tsx`, replace the direct `DesktopRightPanel` conditional child with:

```tsx
<DesktopPresenceTransition
    direction={desktopPanelMode === 'files' ? 'forward' : 'back'}
    immediate={!canShowFilePanel}
    testID="desktop-right-panel-content-transition"
    transitionKey={desktopPanelMode}
>
    {desktopPanelMode === 'files' && canShowFilePanel ? (
        <FilesSidebar
            mode={sidebarMode}
            onAllFilesFilePress={handleAllFilesFilePress}
            onFilePress={handleSidebarFilePress}
            onModeChange={setSidebarMode}
            selectedPath={sidebarMode === 'changes' ? scrollToFile : fileViewPath}
            sessionId={sessionId}
        />
    ) : (
        <SessionRightPanelContent
            composerHandleRef={sessionComposerHandleRef}
            sessionId={sessionId}
            spaceAgent={spaceAgent}
        />
    )}
</DesktopPresenceTransition>
```

- [ ] **Step 5: Wrap the file-sidebar content only**

Keep the current `FilesSidebar` header outside the host and replace only the Changes/All Files conditional with:

```tsx
<DesktopPresenceTransition
    direction={mode === 'allFiles' ? 'forward' : 'back'}
    testID="session-files-mode-transition"
    transitionKey={mode}
>
    {mode === 'changes' ? changesContent : (
        <AllFilesTab
            onFilePress={onAllFilesFilePress}
            selectedPath={selectedPath ?? null}
            sessionId={sessionId}
        />
    )}
</DesktopPresenceTransition>
```

Extract the existing Changes `ScrollView` into the local `changesContent` React node immediately before the return. Do not move the data-fetching effects or state hooks.

- [ ] **Step 6: Add tab color transitions**

Add to `theme.css`:

```css
[data-happy-motion="desktop-tab"],
[data-happy-motion="desktop-tab"] * {
    transition:
        background-color var(--happy-motion-tab-duration) var(--happy-motion-content-ease-out),
        color var(--happy-motion-tab-duration) var(--happy-motion-content-ease-out);
}
```

Inside reduced motion, set `transition: none` for the same two selectors.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
pnpm --filter happy-app exec vitest run \
  sources/components/DesktopPresenceTransition.web.test.tsx \
  sources/components/FilesSidebar.test.tsx \
  sources/-session/SessionView.agentSpace.test.tsx
pnpm --filter happy-app typecheck
```

Expected: all focused tests pass and typecheck exits 0.

- [ ] **Step 8: Commit both tab integrations**

Run:

```bash
git add -- \
  packages/happy-app/sources/components/DesktopRightPanel.tsx \
  packages/happy-app/sources/components/FilesSidebar.tsx \
  packages/happy-app/sources/components/FilesSidebar.test.tsx \
  packages/happy-app/sources/-session/SessionView.tsx \
  packages/happy-app/sources/-session/SessionView.agentSpace.test.tsx \
  packages/happy-app/sources/theme.css
git diff --cached --check
git commit -m "feat(app): animate desktop file tabs"
```

Expected: one self-contained commit for `PC-MOTION-06` and `PC-MOTION-07`.

---

### Task 5: Animate Chat, Diff, and File Overlay History

**Files:**
- Modify: `packages/happy-app/sources/-session/SessionView.tsx:356-425,729-759`
- Modify: `packages/happy-app/sources/-session/SessionView.agentSpace.test.tsx:15-35,170-185,295-305,530-570`

**Interfaces:**
- Consumes: `DesktopPresenceTransition`, the existing `useOverlayNav` publisher, `AllFilesDiffView`, and `FileViewPanel`.
- Produces: `workspace-overlay-transition`, `workspace-diff-panel`, and `workspace-file-panel`; overlay history additionally carries `direction` and `immediate`.

- [ ] **Step 1: Write failing overlay-history tests**

Extend the existing hoisted `mocks` object with stable spies:

```ts
overlayPublish: vi.fn(),
overlayReset: vi.fn(),

vi.mock('@/-session/sessionOverlayNav', () => ({
    useOverlayNav: {
        getState: () => ({ publish: mocks.overlayPublish, reset: mocks.overlayReset }),
    },
}));
```

In a wide Web session with `fileDiffsSidebarEnabled = true`, drive the mocked `FilesSidebar` callbacks and published navigation callbacks:

```ts
act(() => renderer.root.findByProps({ testID: 'desktop-right-panel-files-tab' }).props.onPress());
let filesSidebar = renderer.root.findByType('FilesSidebar');
act(() => filesSidebar.props.onFilePress({ status: 'modified', fullPath: 'src/changed-motion.ts' }));
expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props).toMatchObject({
    direction: 'forward',
    transitionKey: 'diff:src/changed-motion.ts',
});

const publishedAfterDiff = mocks.overlayPublish.mock.calls.at(-1)?.[0];
act(() => publishedAfterDiff.back());
expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props).toMatchObject({
    direction: 'back',
    transitionKey: 'chat',
});

const publishedAfterBack = mocks.overlayPublish.mock.calls.at(-1)?.[0];
act(() => publishedAfterBack.forward());
expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props.direction).toBe('forward');

filesSidebar = renderer.root.findByType('FilesSidebar');
const oldDiffPublisher = renderer.root.findByType('AllFilesDiffView').props.onHeaderRightSlotChange;
act(() => filesSidebar.props.onAllFilesFilePress('src/second-motion.ts'));
expect(renderer.root.findByProps({ testID: 'workspace-overlay-transition' }).props.transitionKey).toBe('file:src/second-motion.ts');
const filePublisher = renderer.root.findByType('FileViewPanel').props.onHeaderRightSlotChange;
act(() => filePublisher('file-header-slot'));
act(() => oldDiffPublisher(null));
expect(renderer.root.findByType('ChatHeaderView').props.children).toContain('file-header-slot');
```

Add a separate assertion that disabling `fileDiffsSidebarEnabled` resets the key to `chat` with `immediate: true` and removes both overlay panel test IDs.

- [ ] **Step 2: Run the SessionView test and verify failure**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/-session/SessionView.agentSpace.test.tsx
```

Expected: FAIL because overlay history has no direction/immediate state and the overlay host test ID is absent.

- [ ] **Step 3: Extend overlay history with navigation intent**

Replace the state shape with:

```ts
type OverlayHistoryState = {
    cursor: number;
    direction: DesktopTransitionDirection;
    immediate: boolean;
    stack: OverlayEntry[];
};

const [overlayHistory, setOverlayHistory] = React.useState<OverlayHistoryState>({
    cursor: 0,
    direction: 'forward',
    immediate: true,
    stack: [{ kind: 'none' }],
});
```

Set `{ direction: 'forward', immediate: false }` in `pushOverlay` and forward navigation; set `{ direction: 'back', immediate: false }` in back navigation. When `canShowFilePanel` becomes false, reset to the initial stack with `direction: 'back'` and `immediate: true`.

Derive the key with no ambiguous path:

```ts
const overlayTransitionKey = overlayCurrent.kind === 'diff'
    ? `diff:${overlayCurrent.file}`
    : overlayCurrent.kind === 'file'
        ? `file:${overlayCurrent.path}`
        : 'chat';
```

Replace the unowned header slot state with an owner-keyed slot so an outgoing overlay's delayed cleanup cannot clear the incoming overlay's controls:

```ts
type OwnedHeaderRightSlot = { ownerKey: string; slot: React.ReactNode };
const [ownedHeaderRightSlot, setOwnedHeaderRightSlot] = React.useState<OwnedHeaderRightSlot>({
    ownerKey: 'chat',
    slot: null,
});
const headerRightSlot = ownedHeaderRightSlot.ownerKey === overlayTransitionKey
    ? ownedHeaderRightSlot.slot
    : null;
const publishOverlayHeaderRightSlot = React.useCallback((slot: React.ReactNode) => {
    setOwnedHeaderRightSlot((current) => {
        if (slot === null && current.ownerKey !== overlayTransitionKey) return current;
        return { ownerKey: overlayTransitionKey, slot };
    });
}, [overlayTransitionKey]);

React.useLayoutEffect(() => {
    setOwnedHeaderRightSlot({ ownerKey: overlayTransitionKey, slot: null });
}, [overlayTransitionKey]);
```

Pass `publishOverlayHeaderRightSlot` to both overlay components. The layout effect clears stale controls before paint when history changes. A retained outgoing ReactNode keeps its old owner-key closure; its later `null` cleanup is ignored after the new owner publishes.

- [ ] **Step 4: Replace the two conditional overlay mounts with one Presence Host**

Keep `mainContent` mounted and render this sibling above it:

```tsx
<View
    pointerEvents="box-none"
    style={{
        position: 'absolute',
        top: safeArea.top + headerHeight,
        left: 0,
        right: 0,
        bottom: 0,
    }}
>
    <DesktopPresenceTransition
        direction={overlayHistory.direction}
        immediate={overlayHistory.immediate}
        testID="workspace-overlay-transition"
        transitionKey={overlayTransitionKey}
    >
        {diffViewOpen && canShowFilePanel ? (
            <View style={workspaceStyles.overlaySurface} testID="workspace-diff-panel">
                <AllFilesDiffView
                    onHeaderRightSlotChange={publishOverlayHeaderRightSlot}
                    scrollToFile={scrollToFile}
                    sessionId={sessionId}
                />
            </View>
        ) : fileViewPath && canShowFilePanel ? (
            <View style={workspaceStyles.overlaySurface} testID="workspace-file-panel">
                <FileViewPanel
                    filePath={fileViewPath}
                    onHeaderRightSlotChange={publishOverlayHeaderRightSlot}
                    sessionId={sessionId}
                />
            </View>
        ) : null}
    </DesktopPresenceTransition>
</View>
```

Define `workspaceStyles.overlaySurface` as absolute fill, `backgroundColor: theme.colors.surface`, and `pointerEvents: 'box-none'`. Do not move `mainContent`, `ChatHeaderView`, or the chat list into the Presence host.

- [ ] **Step 5: Run overlay, Presence, and type tests**

Run:

```bash
pnpm --filter happy-app exec vitest run \
  sources/components/DesktopPresenceTransition.web.test.tsx \
  sources/-session/SessionView.agentSpace.test.tsx
pnpm --filter happy-app typecheck
```

Expected: overlay push/back/forward tests pass, Presence tests remain green, and typecheck exits 0.

- [ ] **Step 6: Commit the workspace history transition**

Run:

```bash
git add -- \
  packages/happy-app/sources/-session/SessionView.tsx \
  packages/happy-app/sources/-session/SessionView.agentSpace.test.tsx
git diff --cached --check
git commit -m "feat(app): animate file overlay history"
```

Expected: one self-contained commit for `PC-MOTION-08`.

---

### Task 6: Run After Evidence, Full Regression, and Final Hygiene

**Files:**
- Verify: `packages/happy-app/e2e/pc-motion-polish-evidence.spec.ts`
- Verify: all files created or modified in Tasks 3–5

**Interfaces:**
- Consumes: Completed Cases `PC-MOTION-06`, `PC-MOTION-07`, and `PC-MOTION-08` plus the before evidence in `/tmp/happy-pc-motion-evidence/before`.
- Produces: after screenshots/video/JSON, a fully green app validation set, and a clean feature worktree.

- [ ] **Step 1: Run the focused unit and component tests**

Run:

```bash
pnpm --filter happy-app exec vitest run \
  sources/components/DesktopPresenceTransition.web.test.tsx \
  sources/components/FilesSidebar.test.tsx \
  sources/-session/SessionView.agentSpace.test.tsx \
  sources/components/Shaker.web.test.tsx \
  sources/components/SidebarNavigator.test.tsx \
  sources/modal/components/CustomModal.test.tsx
```

Expected: every focused test passes with zero retries.

- [ ] **Step 2: Run the complete Happy App unit suite**

Run:

```bash
pnpm --filter happy-app exec vitest run
```

Expected: all Happy App test files pass.

- [ ] **Step 3: Run static and Web build verification**

Run:

```bash
pnpm --filter happy-app typecheck
pnpm --filter happy-app export:web
```

Expected: typecheck and Expo Web export both exit 0.

- [ ] **Step 4: Capture after evidence**

Run:

```bash
mkdir -p /tmp/happy-pc-motion-evidence/after
HAPPY_PC_MOTION_EVIDENCE_PHASE=after \
HAPPY_PC_FILE_TRANSITION_PHASE=after \
HAPPY_PC_MOTION_EVIDENCE_DIR=/tmp/happy-pc-motion-evidence/after \
HAPPY_E2E_RECORD=1 \
pnpm test:e2e:web -- pc-motion-polish-evidence.spec.ts
```

Expected: Cases 01–08 pass, both desktop viewports produce after evidence, right-panel/file content switches record two intermediate layers, workspace overlay transitions record the exact `1 → 1`, `2 → 1`, and `1 → 0` intermediate/settled contracts for Chat → overlay, overlay ↔ overlay, and overlay → Chat respectively, and runtime error increments are all zero. Chat never appears as a workspace Presence layer.

- [ ] **Step 5: Inspect the visual artifacts side by side**

Compare matching before and after PNGs and the recorded MP4. Reject the result if any of these are visible:

- content becomes transparent before the incoming layer is visible;
- horizontal movement exceeds 8px or moves opposite the selected direction;
- right-panel header, tab row, search box, or resize handle shifts vertically;
- two file trees remain visible after 220ms;
- chat flashes or remounts when returning from Diff/File;
- an outgoing layer accepts hover, click, or keyboard focus.

- [ ] **Step 6: Verify reduced motion and rapid switching in E2E output**

Read `/tmp/happy-pc-motion-evidence/after/pc-motion-after-results.json` and confirm:

```json
{
  "runtime": {
    "pageErrors": [],
    "unexpectedConsoleErrors": [],
    "unexpectedFailedRequests": []
  }
}
```

Also confirm every rapid-switch sample reports `layerCount <= 2`, every settled sample reports `layerCount <= 1`, and reduced-motion samples have no entering or exiting phase.

- [ ] **Step 7: Run final diff and repository hygiene checks**

Run:

```bash
git diff --check HEAD~4..HEAD
git status --short --branch
git log --oneline -6
git -C /Users/jacky/jacky-github/happy status --short --branch
git -C /Users/jacky/jacky-github/happy rev-parse HEAD
git -C /Users/jacky/jacky-github/happy rev-parse origin/main
```

Expected: feature worktree is clean; root `main` is clean; root `HEAD` equals `origin/main`; recent history contains separate baseline, E2E, Presence, tab, and overlay commits.

---

## Completion Criteria

The implementation is complete only when all six tasks are checked, the feature worktree is clean, Cases `PC-MOTION-06` through `PC-MOTION-08` have before/after evidence at both required viewports, reduced motion is immediate, rapid switching never exceeds two layers, all unit/E2E/build checks pass without retry, and the root `main` worktree remains untouched.
