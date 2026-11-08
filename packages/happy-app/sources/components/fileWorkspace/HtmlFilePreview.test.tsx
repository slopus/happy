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
vi.mock('./WorkspaceButton', () => ({ WorkspaceButton: 'WorkspaceButton' }));
const assets = vi.hoisted(() => ({ css: 'red', js: 'v1' }));
vi.mock('./htmlPreviewBundle', () => ({ buildHtmlFilePreview: async () => ({ html: `<style>body{color:${assets.css}}</style><script>${assets.js}</script>`, dispose: vi.fn() }) }));
beforeEach(() => { assets.css = 'red'; assets.js = 'v1'; });
import { HtmlFilePreview } from './HtmlFilePreview.web';
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
