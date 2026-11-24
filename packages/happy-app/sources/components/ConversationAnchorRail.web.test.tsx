// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appThemes } from '@/themePacks';
import type { DisplayItem } from '@/hooks/useGroupedMessages';
import { extractUserMessageAnchors } from '@/hooks/useUserMessageAnchors';
import { ConversationAnchorRail } from './ConversationAnchorRail.web';
import { conversationAnchorPreview } from './conversationAnchorPreview.web';

vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (options: any) => options.web ?? options.default } }));
vi.mock('@expo/vector-icons', () => ({ Octicons: () => <span /> }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
const context = vi.hoisted(() => ({ theme: null as any }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: context.theme }) }));

const message = (id: string, kind: 'user-text' | 'agent-text', text: string): DisplayItem => ({
    type: 'message', id, message: { id, kind, text, localId: null, createdAt: 1 },
});
// Newest-first, including progress text and a later final answer in one turn.
const items = [message('a3', 'agent-text', 'Third reply'), message('u3', 'user-text', 'Third prompt'),
    message('a2', 'agent-text', '**Final answer** with [a link](https://example.com)'),
    message('progress', 'agent-text', 'Working on it'), message('u2', 'user-text', 'Second prompt'),
    message('a1', 'agent-text', 'First reply'), message('u1', 'user-text', 'First prompt')];
const rect = (top: number, width: number, height: number) => ({ top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON() {} });

describe('conversation anchor rail', () => {
    let root: Root;
    let host: HTMLDivElement;
    let viewport: HTMLDivElement;
    let scroll: HTMLDivElement;
    let props: React.ComponentProps<typeof ConversationAnchorRail>;
    let width = 800;
    let finePointer = true;
    let resizeCallback: () => void;
    let frames: Array<FrameRequestCallback>;
    const flush = () => act(() => { const pending = frames.splice(0); pending.forEach(callback => callback(0)); });
    const track = () => host.querySelector<HTMLButtonElement>('[data-testid="conversation-anchor-track"]')!;
    const move = (clientY: number) => act(() => track().dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY })));
    const press = (key: string) => act(() => track().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, cancelable: true })));

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        context.theme = appThemes.ginghamDark;
        width = 800; finePointer = true; frames = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallback = callback; } observe() {} disconnect() {} });
        vi.stubGlobal('matchMedia', () => ({ matches: finePointer, addEventListener() {}, removeEventListener() {} }));
        host = document.createElement('div'); viewport = document.createElement('div'); scroll = document.createElement('div');
        viewport.append(scroll); document.body.append(viewport, host);
        viewport.getBoundingClientRect = () => rect(0, width, 600);
        scroll.getBoundingClientRect = () => rect(0, width, 600);
        Object.defineProperty(scroll, 'clientHeight', { value: 600 });
        const rows = items.toReversed().map(item => ({ id: item.id, renderKey: item.id }));
        rows.forEach((row, index) => {
            const node = document.createElement('div'); node.dataset.transcriptKey = row.renderKey;
            node.getBoundingClientRect = () => rect(index * 150, width, 150); scroll.append(node);
        });
        props = { anchors: extractUserMessageAnchors(items), items, rows,
            viewportRef: { current: viewport } as any, listRef: { current: { getScrollableNode: () => scroll } } as any,
            inverted: false, onSelect: vi.fn(), onOpenList: vi.fn(), onAvailabilityChange: vi.fn() };
        root = createRoot(host);
        act(() => root.render(<ConversationAnchorRail {...props} />));
        track().getBoundingClientRect = () => rect(288, 32, 24);
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); viewport.remove(); vi.unstubAllGlobals(); });

    it('previews the final reply from the hovered turn without markup or crossing prompts', () => {
        move(300);
        const preview = host.querySelector('[role="tooltip"]')!;
        expect(preview.textContent).toBe('Second promptFinal answer with a link');
        expect(preview.textContent).not.toContain('Third reply');
        expect(host.querySelector('[data-anchor-id="u2"]')?.getAttribute('data-current')).toBe('false');
    });

    it('jumps with the pointer, supports keyboard selection, and dismisses the preview', () => {
        act(() => track().dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 308, detail: 1 })));
        expect(props.onSelect).toHaveBeenLastCalledWith(props.anchors[2]);
        act(() => track().focus()); press('End');
        expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('Third prompt');
        press('ArrowUp');
        act(() => track().click());
        expect(props.onSelect).toHaveBeenLastCalledWith(props.anchors[1]);
        press('Home'); press('Escape');
        expect(host.querySelector('[role="tooltip"]')).toBeNull();
        expect(document.activeElement).toBe(track());
    });

    it('tracks the actual visible turn while scrolling, including its assistant rows', () => {
        const nodes = [...scroll.children] as HTMLElement[];
        nodes.forEach((node, index) => { node.getBoundingClientRect = () => rect(index * 150 - 500, width, 150); });
        act(() => scroll.dispatchEvent(new Event('scroll'))); flush();
        expect(host.querySelector('[data-anchor-id="u2"]')?.getAttribute('data-current')).toBe('true');
    });

    it('keeps the hovered prompt identity when older history is inserted', () => {
        move(300);
        const nextItems = [...items, message('old', 'user-text', 'Older history')];
        act(() => root.render(<ConversationAnchorRail {...props} items={nextItems} anchors={extractUserMessageAnchors(nextItems)} />));
        expect(host.querySelector('[role="tooltip"]')?.textContent).toContain('Second prompt');
    });

    it('uses the current nondefault dark theme and leaves the full list accessible', () => {
        move(300);
        const preview = host.querySelector<HTMLElement>('[role="tooltip"]')!;
        const expected = document.createElement('div'); expected.style.background = context.theme.colors.surface;
        expect(preview.style.background).toBe(expected.style.background);
        act(() => host.querySelector<HTMLButtonElement>('.paws-anchor-list')!.click());
        expect(props.onOpenList).toHaveBeenCalledOnce();
    });

    it('returns to the sheet when the conversation column becomes narrow', () => {
        width = 480; resizeCallback(); flush();
        expect(host.querySelector('[data-testid="conversation-anchor-rail"]')).toBeNull();
        expect(props.onAvailabilityChange).toHaveBeenLastCalledWith(false);
    });

    it.each([false, true])('keeps the new rail with one loaded prompt (older history: %s)', hasMoreOlder => {
        const singleItems = items.slice(0, 2);
        const singleAnchors = extractUserMessageAnchors(singleItems);
        act(() => root.render(<ConversationAnchorRail {...props} items={singleItems}
            anchors={singleAnchors} hasMoreOlder={hasMoreOlder} />));
        expect(track()).not.toBeNull();
        track().getBoundingClientRect = () => rect(292, 32, 16);
        move(300);
        expect(host.querySelector('[role="tooltip"]')?.textContent).toBe('Third promptThird reply');
        expect(Number.isFinite(parseFloat(host.querySelector<HTMLElement>('[data-anchor-id]')!.style.top))).toBe(true);
        act(() => track().click());
        expect(props.onSelect).toHaveBeenLastCalledWith(singleAnchors[0]);
        expect(props.onAvailabilityChange).toHaveBeenLastCalledWith(true);
    });

    it('keeps a visible sidebar history entry when prompts are outside the loaded page', () => {
        act(() => root.render(<ConversationAnchorRail {...props} anchors={[]} hasMoreOlder />));
        expect(host.querySelector('[data-testid="conversation-anchor-rail"]')).not.toBeNull();
        expect(track()).toBeNull();
        const history = host.querySelector<HTMLButtonElement>('.paws-anchor-list')!;
        expect(history.style.opacity).toBe('1');
        act(() => history.click());
        expect(props.onOpenList).toHaveBeenCalledOnce();
        expect(props.onAvailabilityChange).toHaveBeenLastCalledWith(true);
    });
});

it('extracts grouped assistant text and does not leak another turn into an unanswered prompt', () => {
    const grouped: DisplayItem[] = [{ type: 'agent-work-group', id: 'work', messages: [
        { kind: 'agent-text', id: 'g1', text: 'Progress', createdAt: 2, localId: null },
        { kind: 'agent-text', id: 'g2', text: 'Final grouped reply', createdAt: 3, localId: null },
    ], hasRunning: false, hasPendingPermission: false, startedAt: 2, completedAt: 3 }, message('user', 'user-text', 'Prompt')];
    expect(conversationAnchorPreview(extractUserMessageAnchors(grouped)[0], grouped).reply).toBe('Final grouped reply');
    const unanswered = [message('new', 'user-text', 'Unanswered'), ...items];
    expect(conversationAnchorPreview(extractUserMessageAnchors(unanswered).at(-1)!, unanswered).reply).toBe('');
});
