import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { AnnotatableFile } from '@/components/annotations/MessageAnnotations';
import { FileWorkspaceController } from './controller';
const state = vi.hoisted(() => ({ skin: 'gingham', reduced: false, alert: vi.fn() }));
const theme = vi.hoisted(() => ({ dark: true, colors: {
    surface: '#101820', surfaceSelected: '#354550', surfacePressed: '#283640', divider: '#445566', text: '#ffffff', textSecondary: '#aabbcc', textLink: '#77aaff',
    desktopSkin: { readingSolid: '#151a21', readingCompact: 'rgba(21,26,33,0.70)', readingWide: 'rgba(21,26,33,0.51)' },
} }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme }) }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => state.skin }));
vi.mock('@/hooks/useReducedTransparency', () => ({ useReducedTransparency: () => state.reduced }));
vi.mock('@/modal', () => ({ Modal: { alert: state.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/CodeEditor', () => ({ CodeEditor: 'CodeEditor' }));
vi.mock('./WorkspaceButton', () => ({ WorkspaceButton: 'WorkspaceButton' }));
vi.mock('./FileTabContextMenu', () => ({ FileTabContextMenu: 'TabMenu' }));
vi.mock('./VersionHistoryPanel', () => ({ VersionHistoryPanel: 'VersionHistoryPanel' }));
vi.mock('./ArtifactPreview', () => ({ ArtifactPreview: 'ArtifactPreview' }));
vi.mock('./HtmlFilePreview', () => ({ HtmlFilePreview: 'HtmlFilePreview' }));
import { FileWorkspaceContext } from './context';
import { FileWorkspace, FileWorkspaceResizeHandle } from './FileWorkspace';
let controller: FileWorkspaceController;
let maximized = false;
let expanded = true;
const toggleTree = vi.fn();
function Harness() {
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const value = { enabled: true, root: '/work', snapshot, controller, maximized, setMaximized: vi.fn(),
        versions: { currentForHash: () => null }, setReference: vi.fn() } as any;
    return <FileWorkspaceContext.Provider value={value}><FileWorkspace sessionId="s" fileTreeExpanded={expanded} onToggleFileTree={toggleTree} /></FileWorkspaceContext.Provider>;
}
beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    controller = new FileWorkspaceController({ root: '/work', read: async () => ({ content: '# Base', hash: 'base' }), write: async () => ({ hash: 'saved' }) });
    await controller.open('a.md'); await controller.open('b.md'); await controller.open('c.md');
    maximized = false; expanded = true; state.reduced = false; state.skin = 'gingham'; state.alert.mockReset(); toggleTree.mockReset();
});
it('opens actions on the clicked tab without switching the active document', () => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<Harness />); });
    act(() => renderer.root.findByProps({ testID: 'workspace-tab:/work/b.md' }).props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 20, clientY: 30, currentTarget: null }));
    expect(renderer.root.findByType('TabMenu').props.anchor).toMatchObject({ path: '/work/b.md', x: 20, y: 30 });
    expect(controller.getSnapshot().active).toBe('/work/c.md');
    act(() => renderer.root.findByType('TabMenu').props.onAction(['/work/a.md']));
    expect(controller.getSnapshot().tabs).toEqual(['/work/b.md', '/work/c.md']);
    act(() => renderer.unmount());
});
it('keeps the entire group on cancel and saves before closing when requested', async () => {
    controller.edit('/work/b.md', '# Draft');
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<Harness />); });
    act(() => renderer.root.findByType('TabMenu').props.onAction(controller.getSnapshot().tabs));
    expect(controller.getSnapshot().tabs).toHaveLength(3);
    const buttons = state.alert.mock.calls[0][2];
    expect(buttons.find((button: any) => button.style === 'cancel')).toBeDefined();
    await act(async () => { await buttons.find((button: any) => button.text === 'fileWorkspace.save').onPress(); });
    expect(controller.getSnapshot().tabs).toEqual([]);
    act(() => renderer.unmount());
});
it('discards a group only after the explicit destructive action', () => {
    controller.edit('/work/b.md', '# Draft');
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<Harness />); });
    act(() => renderer.root.findByType('TabMenu').props.onAction(controller.getSnapshot().tabs));
    expect(controller.getSnapshot().tabs).toHaveLength(3);
    act(() => state.alert.mock.calls[0][2].find((button: any) => button.style === 'destructive').onPress());
    expect(controller.getSnapshot().tabs).toEqual([]);
    act(() => renderer.unmount());
});
it('keeps one full-width themed reading background when maximized and supports reduced transparency', () => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<Harness />); });
    const surface = () => renderer.root.findByProps({ testID: 'file-workspace' }).props.style;
    expect(surface().backgroundColor).toBe(theme.colors.desktopSkin.readingWide);
    const headers = () => renderer.root.findAll((node: any) => node.type === 'View' && (node.props.style?.minHeight === 46 || node.props.style?.flexWrap === 'wrap'));
    expect(headers()).toHaveLength(2);
    expect(headers().map((node: any) => node.props.style.backgroundColor)).toEqual(['transparent', 'transparent']);
    maximized = true;
    act(() => renderer.update(<Harness />));
    expect(surface().backgroundColor).toBe(theme.colors.desktopSkin.readingWide);
    expect(surface().paddingTop ?? 0).toBe(0);
    expect(surface().maxWidth).toBeUndefined();
    state.reduced = true;
    act(() => renderer.update(<Harness />));
    expect(surface().backgroundColor).toBe(theme.colors.desktopSkin.readingSolid);
    state.skin = 'default';
    act(() => renderer.update(<Harness />));
    expect(surface().backgroundColor).toBe(theme.colors.surface);
    expect(headers().map((node: any) => node.props.style.backgroundColor)).toEqual([theme.colors.surface, theme.colors.surface]);
    act(() => renderer.unmount());
});
it('keeps the file tree toggle available after collapsing it and in full-screen mode', () => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<Harness />); });
    const button = () => renderer.root.findByProps({ testID: 'workspace-toggle-file-tree' });
    expect(button().props.label).toBe('fileWorkspace.hideFileTree');
    act(() => button().props.onPress());
    expect(toggleTree).toHaveBeenCalledTimes(1);
    expanded = false; maximized = true;
    act(() => renderer.update(<Harness />));
    expect(button().props.label).toBe('fileWorkspace.showFileTree');
    act(() => button().props.onPress());
    expect(toggleTree).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
});

it('keeps the resize cue visible through a captured drag and clears cancelled gestures', () => {
    const setChatWidth = vi.fn();
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<FileWorkspaceContext.Provider value={{ setChatWidth } as any}><FileWorkspaceResizeHandle width={800} maximumWidth={1200} /></FileWorkspaceContext.Provider>); });
    const handle = () => renderer.root.findByProps({ role: 'separator' });
    const cue = () => handle().findByProps({ 'aria-hidden': true }).props.style;
    expect(cue().opacity).toBe(0);
    act(() => handle().props.onFocus());
    expect(cue()).toMatchObject({ opacity: 1, background: theme.colors.textLink });
    act(() => handle().props.onBlur());
    act(() => handle().props.onPointerEnter());
    expect(cue()).toMatchObject({ opacity: 1, background: theme.colors.divider });
    const setPointerCapture = vi.fn();
    act(() => handle().props.onPointerDown({ preventDefault() {}, clientX: 700, pointerId: 1, currentTarget: { setPointerCapture, previousElementSibling: { getBoundingClientRect: () => ({ width: 700 }) } } }));
    act(() => handle().props.onPointerLeave());
    expect(cue()).toMatchObject({ opacity: 1, background: theme.colors.textLink });
    act(() => handle().props.onPointerMove({ clientX: 750, pointerId: 1 }));
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(setChatWidth).toHaveBeenLastCalledWith(750);
    act(() => handle().props.onPointerCancel());
    expect(cue().opacity).toBe(0);
    setChatWidth.mockClear();
    act(() => handle().props.onPointerMove({ clientX: 900, pointerId: 1 }));
    expect(setChatWidth).not.toHaveBeenCalled();
    act(() => handle().props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }));
    expect(setChatWidth).toHaveBeenLastCalledWith(816);
    act(() => handle().props.onKeyDown({ key: 'End', preventDefault() {} }));
    expect(setChatWidth).toHaveBeenLastCalledWith(1200);
    act(() => renderer.unmount());
});

it('binds Markdown annotations to the saved file and disables them for unsaved content', () => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<Harness />); });
    const annotation = () => renderer.root.findByType(AnnotatableFile);
    expect(annotation().props).toMatchObject({ sessionId: 's', file: { path: '/work/c.md', hash: 'base' } });
    act(() => controller.edit('/work/c.md', '# Unsaved'));
    expect(annotation().props.file).toBeNull();
    expect(renderer.root.findByType('MarkdownView').props.markdown).toBe('# Unsaved');
    act(() => renderer.unmount());
});


it('suspends current-file annotations while history is open and restores them on close', () => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<Harness />); });
    expect(renderer.root.findByType(AnnotatableFile).props.file?.hash).toBe('base');
    act(() => renderer.root.findByProps({ testID: 'workspace-history-open' }).props.onPress());
    expect(renderer.root.findByType(AnnotatableFile).props.file).toBeNull();
    expect(renderer.root.findByType('VersionHistoryPanel')).toBeDefined();
    act(() => renderer.root.findByType('VersionHistoryPanel').props.onClose());
    expect(renderer.root.findByType(AnnotatableFile).props.file?.hash).toBe('base');
    act(() => renderer.unmount());
});
