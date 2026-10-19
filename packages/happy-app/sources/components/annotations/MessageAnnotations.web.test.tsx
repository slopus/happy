// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default } }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks');
    return { useUnistyles: () => ({ theme: appThemes.ginghamDark }) };
});
vi.mock('@/text', async () => {
    const { zhHans } = await import('@/text/translations/zh-Hans');
    return { t: (key: string, params: unknown) => { const value = key.split('.').reduce((v: any, part) => v[part], zhHans); return typeof value === 'function' ? value(params) : value; } };
});
vi.mock('./annotationRuntime', async () => {
    const { createAnnotationDraftStore } = await import('./annotationDraft');
    const { useCallback, useSyncExternalStore } = await import('react');
    let id = 0;
    const store = createAnnotationDraftStore({ read: () => undefined, write: () => {}, newId: () => `test-${++id}` });
    return { annotationDraftStore: store, useMessageAnnotations: (sessionId: string) => useSyncExternalStore(store.subscribe, useCallback(() => store.getSnapshot(sessionId), [sessionId])) };
});
import { AnnotationComposer, AnnotatableMessage } from './MessageAnnotations.web';
import { annotationDraftStore } from './annotationRuntime';
let root: Root, mount: HTMLDivElement;
let session = 0;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
    vi.stubGlobal('CSS', { highlights: new Map() });
    vi.stubGlobal('Highlight', class { constructor(..._ranges: Range[]) {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 20, top: 40, bottom: 60 }) });
});
afterEach(() => { act(() => root.unmount()); mount.remove(); vi.unstubAllGlobals(); });

describe('annotation UI with a non-default dark theme', () => {
    it('renders the real list/editor surfaces and hover feedback in gingham dark', () => {
        const sessionId = `theme-${++session}`;
        const item = annotationDraftStore.add(sessionId, { messageId: 'reply', quote: '应用版本', anchorText: '应用版本', start: 0, end: 4 });
        annotationDraftStore.update(sessionId, item.id, '原评论');
        act(() => root.render(<AnnotationComposer sessionId={sessionId} />));
        act(() => (document.querySelector('[data-testid=annotation-summary]') as HTMLButtonElement).click());
        const list = document.querySelector('[data-testid=annotation-list]')!;
        expect(getComputedStyle(list).backgroundColor).toBe('rgb(26, 35, 48)');
        const edit = document.querySelector('[data-testid=annotation-edit]') as HTMLButtonElement;
        act(() => edit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(getComputedStyle(edit).backgroundColor).toBe('rgb(31, 42, 56)');
        act(() => edit.click());
        expect((document.querySelector('[data-testid=annotation-comment-input]') as HTMLTextAreaElement).value).toBe('原评论');
        expect(getComputedStyle(document.querySelector('[data-testid=annotation-editor]')!).backgroundColor).toBe('rgb(26, 35, 48)');
    });
    it('keeps the add menu attached to a live Markdown selection during layout scrolling', () => {
        const sessionId = `scroll-${++session}`;
        act(() => root.render(<AnnotatableMessage sessionId={sessionId} messageId="reply" enabled><p>应用<strong>版本</strong>说明代码。</p></AnnotatableMessage>));
        const source = document.querySelector('[data-testid=annotation-source-content]')!;
        const range = document.createRange(); range.setStart(source.querySelector('p')!.firstChild!, 0); range.setEnd(source.querySelector('strong')!.firstChild!, 2);
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
        act(() => source.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
        expect(document.querySelector('[data-testid=annotation-add]')).not.toBeNull();
        act(() => window.dispatchEvent(new Event('scroll')));
        expect(document.querySelector('[data-testid=annotation-add]')).not.toBeNull();
        act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(document.querySelector('[data-testid=annotation-add]')).toBeNull();
    });
    it('uses the selected token on the actual source highlight while retaining its DOM anchor', () => {
        const sessionId = `theme-${++session}`;
        annotationDraftStore.add(sessionId, { messageId: 'reply', quote: '应用版本', anchorText: '应用版本', start: 0, end: 4 });
        act(() => root.render(<AnnotatableMessage sessionId={sessionId} messageId="reply" enabled><p>应用<strong>版本</strong>说明代码。</p></AnnotatableMessage>));
        expect(document.querySelector('[data-testid=annotation-source-reply] style')!.textContent).toContain('background-color: #283544');
        expect((CSS as any).highlights.size).toBe(1);
        expect(document.querySelector('[data-testid=annotation-badge]')!.textContent).toBe('1');
    });
});
