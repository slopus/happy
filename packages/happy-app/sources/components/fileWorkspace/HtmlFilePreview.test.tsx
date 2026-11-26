import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./fileIO', () => ({ readWorkspaceBytes: vi.fn() }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: vi.fn() } }));
vi.mock('./WorkspaceButton', () => ({ WorkspaceButton: 'WorkspaceButton' }));
const assets = vi.hoisted(() => ({ css: 'red', js: 'v1' }));
vi.mock('./htmlPreviewRuntime.web', () => ({ buildHtmlFilePreview: vi.fn(async () => ({ html: `<style>body{color:${assets.css}}</style><script>${assets.js}</script>`, dispose: vi.fn() })) }));
beforeEach(() => { assets.css = 'red'; assets.js = 'v1'; });
import { HtmlFilePreview } from './HtmlFilePreview.web';
it('keeps an interactive Task iframe alive when its conversation changes', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const reader = vi.fn(async () => new Uint8Array());
    let renderer: any;
    const node = (sessionId: string) => <HtmlFilePreview sessionId={sessionId} path="/task/demo.html" root="/task" content="<h1>Task</h1>" readBytes={reader} />;
    await act(async () => { renderer = TestRenderer.create(node('discussion-one')); });
    try {
        await act(async () => { renderer.root.findByType('WorkspaceButton').props.onPress(); });
        const iframe = renderer.root.findByType('iframe');
        expect(iframe.props.sandbox).toBe('allow-scripts');
        await act(async () => { renderer.update(node('discussion-two')); });
        expect(renderer.root.findByType('iframe')).toBe(iframe);
        expect(renderer.root.findByType('iframe').props.sandbox).toBe('allow-scripts');
    } finally { await act(async () => { renderer.unmount(); }); }
});
it('requires an explicit interaction action before allowing artifact scripts, and resets on another file', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<HtmlFilePreview key="a" sessionId="s" path="/work/a.html" root="/work" content="<h1>preview</h1>" />); });
    expect(renderer.root.findByType('iframe').props.sandbox).toBe('');
    await act(async () => { renderer.root.findByType('WorkspaceButton').props.onPress(); });
    expect(renderer.root.findByType('iframe').props.sandbox).toBe('allow-scripts');
    await act(async () => { renderer.update(<HtmlFilePreview key="b" sessionId="s" path="/work/b.html" root="/work" content="<h1>preview</h1>" />); });
    expect(renderer.root.findByType('iframe').props.sandbox).toBe('');
    await act(async () => { renderer.unmount(); });
});

import { FileWorkspaceController } from './controller';
it.each(['css', 'js'] as const)('refreshes changed %s dependencies when HTML bytes stay identical', async resource => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const html = '<h1>unchanged</h1>';
    const controller = new FileWorkspaceController({ root: '/work', read: async () => ({ content: html, hash: 'same' }), write: async () => ({ hash: 'saved' }) });
    await controller.open('index.html');
    function Parent() {
        const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
        const document = snapshot.documents['/work/index.html'];
        return <HtmlFilePreview sessionId="s" path="/work/index.html" root="/work" content={document.draft} revision={document.revision} />;
    }
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<Parent />); });
    if (resource === 'css') assets.css = 'blue'; else assets.js = 'v2';
    await act(async () => { await controller.refresh('/work/index.html'); });
    expect(renderer.root.findByType('iframe').props.srcDoc).toContain(resource === 'css' ? 'color:blue' : 'v2');
    expect(controller.getSnapshot().documents['/work/index.html'].content).toBe(html);
    await act(async () => { renderer.unmount(); });
});

import { buildHtmlFilePreview } from './htmlPreviewRuntime.web';
import { readWorkspaceBytes } from './fileIO';
it('reads external HTML dependencies through the read-only RPC within the HTML directory', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<HtmlFilePreview sessionId="s" path="/Volumes/SSD/demo/index.html" root="/home/task" content="<h1>External</h1>" />); });
    const call = vi.mocked(buildHtmlFilePreview).mock.calls.at(-1)!;
    expect(call[2]).toBe('/Volumes/SSD/demo');
    await call[3]('/Volumes/SSD/demo/style.css');
    expect(readWorkspaceBytes).toHaveBeenLastCalledWith('s', '/Volumes/SSD/demo/style.css', undefined, true);
    await act(async () => { renderer.unmount(); });
});

import { apiSocket } from '@/sync/apiSocket';
it('uses bounded media RPCs with the selected external preview scope', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(apiSocket.sessionRPC).mockResolvedValue({ success: true, content: btoa('video'), totalSize: 5, offset: 0, revision: 'r1' });
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<HtmlFilePreview sessionId="s" path="/Volumes/SSD/demo/index.html" root="/home/task" content="<h1>External</h1>" />); });
    const read = vi.mocked(buildHtmlFilePreview).mock.calls.at(-1)![3];
    expect(await read('/Volumes/SSD/demo/film.mp4')).toEqual(new TextEncoder().encode('video'));
    expect(apiSocket.sessionRPC).toHaveBeenLastCalledWith('s', 'readFileChunk', { path: '/Volumes/SSD/demo/film.mp4', scopeRoot: '/Volumes/SSD/demo', offset: 0, length: 256 * 1024 });
    await act(async () => { renderer.unmount(); });
});
it('keeps archive media on its bound reader without using the session media RPC', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(apiSocket.sessionRPC).mockClear();
    const reader = vi.fn(async () => new Uint8Array([1, 2]));
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<HtmlFilePreview sessionId="s" path="/archive/index.html" root="/archive" content="<h1>Archive</h1>" readBytes={reader} />); });
    const call = vi.mocked(buildHtmlFilePreview).mock.calls.at(-1)!;
    expect(call[2]).toBe('/archive');
    expect(await call[3]('/archive/film.mp4')).toEqual(new Uint8Array([1, 2]));
    expect(apiSocket.sessionRPC).not.toHaveBeenCalled();
    await act(async () => { renderer.unmount(); });
});
