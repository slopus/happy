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
import { AnnotationComposer, AnnotatableMessage, AnnotatableFile, prepareAnnotatedMessage, restoreAnnotatedMessage, FileAnnotationPanel, FileAnnotationControls } from './MessageAnnotations.web';
import { annotationDraftStore } from './annotationRuntime';
import { fileAnnotationSourceId } from './annotationDraft';
import { FileWorkspaceContext } from '../fileWorkspace/context';
import { FileWorkspaceController } from '../fileWorkspace/controller';
let root: Root, mount: HTMLDivElement;
let session = 0;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
    getSelection()!.removeAllRanges();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('CSS', { highlights: new Map() });
    vi.stubGlobal('Highlight', class { constructor(..._ranges: Range[]) {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 20, top: 40, bottom: 60, right: 220, width: 200, height: 20 }) });
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

function typeComment(value: string) {
    const input = document.querySelector('[data-testid=annotation-comment-input]') as HTMLInputElement;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
function saveComment(value: string) {
    typeComment(value);
    act(() => (document.querySelector('[data-testid=annotation-save]') as HTMLButtonElement).click());
}
it('collects passages across files through capsules and previews them above the composer', () => {
    const sessionId = `file-${++session}`;
    const first = { path: '/work/first.md', hash: 'baseline-a' };
    const second = { path: '/work/second.md', hash: 'baseline-b' };
    const render = (file: typeof first | null) => <><AnnotatableFile sessionId={sessionId} file={file}><p>应用<strong>版本</strong>说明代码。</p></AnnotatableFile><AnnotationComposer sessionId={sessionId} /><FileAnnotationPanel sessionId={sessionId} /></>;
    const select = () => {
        const source = document.querySelector('[data-testid=annotation-source-content]')!;
        const range = document.createRange(); range.setStart(source.querySelector('p')!.firstChild!, 0); range.setEnd(source.querySelector('strong')!.firstChild!, 2);
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
        act(() => source.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
        act(() => (document.querySelector('[data-testid=annotation-add]') as HTMLButtonElement).click());
    };
    act(() => root.render(render(first))); select();
    const capsule = document.querySelector('[data-testid=annotation-editor]')!;
    expect(capsule.getAttribute('data-annotation-surface')).toBe('capsule');
    expect(capsule.querySelector('textarea')).toBeNull();
    expect(capsule.querySelector('blockquote')).toBeNull();
    expect(capsule.querySelector('button[aria-label="取消"]')).toBeNull();
    expect(capsule.querySelector('form')!.getAttribute('data-annotation-quote')).toBe('应用版本');
    expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(0);
    expect((document.querySelector('[data-testid=annotation-save]') as HTMLButtonElement).disabled).toBe(true);
    saveComment('把这段写得更具体');
    expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(1);
    act(() => root.render(render(second))); select(); saveComment('补充一个例子');
    expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(2);
    act(() => (document.querySelector('[data-testid=annotation-file-summary]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid=file-annotation-panel]')).toBeNull();
    expect(document.querySelector('[data-testid=file-annotation-preview]')).not.toBeNull();
    expect([...document.querySelectorAll('[data-testid=annotation-saved-comment]')].map(el => el.textContent)).toEqual(['把这段写得更具体', '补充一个例子']);
    const prepared = prepareAnnotatedMessage(sessionId, '一起修改');
    expect(prepared.text).toContain('baseline-a'); expect(prepared.text).toContain('baseline-b');
    expect(prepared.displayText).toContain('把这段写得更具体'); expect(prepared.displayText).not.toContain('baseline-');
    act(() => prepared.commit()); expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(0);
    act(() => restoreAnnotatedMessage(sessionId, prepared.annotations));
    act(() => root.render(render(first))); expect(document.querySelectorAll('[data-testid=annotation-badge]')).toHaveLength(1);
    act(() => root.render(render({ ...first, hash: 'changed' }))); expect(document.querySelectorAll('[data-testid=annotation-badge]')).toHaveLength(0);
    expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(2);
});
it('supports whitespace dismissal, IME-safe Enter, a saved comment bubble and preview editing/deletion', () => {
    const sessionId = `point-${++session}`;
    const file = { path: '/work/readme.md', hash: 'baseline' };
    act(() => root.render(<><FileAnnotationControls sessionId={sessionId} enabled /><AnnotatableFile sessionId={sessionId} file={file}><div data-annotation-block="text"><p>需要修改的完整段落。</p></div></AnnotatableFile><AnnotationComposer sessionId={sessionId} /><FileAnnotationPanel sessionId={sessionId} /></>));
    const target = document.querySelector('[data-annotation-block]') as HTMLElement;
    act(() => target.click()); expect(document.querySelector('[data-testid=annotation-editor]')).toBeNull();
    act(() => (document.querySelector('[data-testid=file-annotation-mode]') as HTMLButtonElement).click());
    act(() => target.click()); typeComment('待取消的评论');
    act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(document.querySelector('[data-testid=annotation-editor]')).toBeNull(); expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(0);
    act(() => target.click()); typeComment('简化这一段');
    const input = document.querySelector('[data-testid=annotation-comment-input]')!;
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(0);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(annotationDraftStore.getSnapshot(sessionId)[0].comment).toBe('简化这一段');
    expect(document.querySelector('[data-testid=annotation-badge]')!.textContent).toBe('1');
    expect(document.querySelector('[data-testid=file-annotation-bubble]')!.textContent).toBe('简化这一段');
    expect(document.querySelector('[data-testid=file-annotation-bubble]')!.querySelector('button')).toBeNull();
    act(() => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(document.querySelector('[data-testid=file-annotation-bubble]')).toBeNull();
    act(() => (document.querySelector('[data-testid=annotation-file-summary]') as HTMLButtonElement).click());
    act(() => (document.querySelector('[data-testid=annotation-edit]') as HTMLButtonElement).click());
    expect((document.querySelector('[data-testid=annotation-comment-input]') as HTMLInputElement).value).toBe('简化这一段');
    saveComment('保留核心结论');
    expect(document.querySelector('[data-testid=annotation-editor]')).toBeNull();
    expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(1);
    act(() => (document.querySelector('[data-testid=annotation-file-summary]') as HTMLButtonElement).click());
    act(() => (document.querySelector('[data-testid=annotation-remove]') as HTMLButtonElement).click());
    expect(annotationDraftStore.getSnapshot(sessionId)).toHaveLength(0);
    expect(document.querySelector('[data-testid=annotation-badge]')).toBeNull();
});


it('removes file portals when current annotations are suspended without losing the comment', () => {
    const sessionId = `history-${++session}`;
    const file = { path: '/work/readme.md', hash: 'baseline' };
    annotationDraftStore.add(sessionId, { messageId: fileAnnotationSourceId(file), file, quote: '原文段落', anchorText: '原文段落', start: 0, end: 4 }, '保留这条意见');
    const render = (visible: boolean) => <><AnnotatableFile sessionId={sessionId} file={visible ? file : null}><p>原文段落</p></AnnotatableFile><FileAnnotationPanel sessionId={sessionId} /></>;
    act(() => root.render(render(true)));
    act(() => (document.querySelector('[data-testid=annotation-badge]') as HTMLButtonElement).focus());
    expect(document.querySelector('[data-testid=file-annotation-bubble]')).not.toBeNull();
    act(() => root.render(render(false)));
    expect(document.querySelector('[data-testid=file-annotation-bubble]')).toBeNull();
    act(() => root.render(render(true)));
    act(() => (document.querySelector('[data-testid=annotation-badge]') as HTMLButtonElement).click());
    act(() => (document.querySelector('[data-testid=file-annotation-bubble] [role=button]') as HTMLElement).click());
    expect(document.querySelector('[data-testid=annotation-editor]')).not.toBeNull();
    act(() => root.render(render(false)));
    expect(document.querySelector('[data-testid=annotation-editor]')).toBeNull();
    expect(annotationDraftStore.getSnapshot(sessionId)[0].comment).toBe('保留这条意见');
});

it.each(['changed', 'dirty', 'error'])('reports an unlocatable %s file without discarding or reanchoring the comment', async kind => {
    const sessionId = `unlocated-${kind}-${++session}`;
    const file = { path: '/work/readme.md', hash: 'baseline' };
    const item = annotationDraftStore.add(sessionId, { messageId: fileAnnotationSourceId(file), file, quote: '原文段落', anchorText: '原文段落', start: 0, end: 4 }, '保留旧意见');
    const controller = new FileWorkspaceController({ root: '/work', read: async () => { if (kind === 'error') throw new Error('READ_FAILED'); return { content: '原文段落', hash: kind === 'changed' ? 'changed' : 'baseline' }; }, write: async () => ({ hash: 'saved' }) });
    await controller.open(file.path);
    if (kind === 'dirty') controller.edit(file.path, '未保存的内容');
    const workspace = { controller, openReference: async (path: string) => { await controller.open(path); } } as any;
    act(() => root.render(<FileWorkspaceContext.Provider value={workspace}><AnnotationComposer sessionId={sessionId} /></FileWorkspaceContext.Provider>));
    act(() => (document.querySelector('[data-testid=annotation-file-summary]') as HTMLButtonElement).click());
    await act(async () => { (document.querySelector('[data-testid=file-annotation-preview-row]') as HTMLElement).click(); });
    expect(document.querySelector('[role=alert]')!.textContent).toBe('原文已变化或无法定位，原批注仍保留。');
    expect(document.querySelector('[data-testid=annotation-editor]')).toBeNull();
    expect(annotationDraftStore.getSnapshot(sessionId)).toEqual([item]);
});
