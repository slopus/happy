// @vitest-environment jsdom
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

import { HtmlFilePreview } from './HtmlFilePreview.web';
import { readWorkspaceBytes } from './fileIO';

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
});

it.each(['unmount', 'file change', 'refresh'] as const)('stops the real static builder from reading later images after %s', async action => {
    const calls: string[] = [];
    let release!: (bytes: Uint8Array) => void;
    const firstRead = new Promise<Uint8Array>(resolve => { release = resolve; });
    const image = new TextEncoder().encode('image');
    vi.mocked(readWorkspaceBytes).mockImplementation(async (_session, file) => {
        calls.push(file);
        return calls.length === 1 ? firstRead : image;
    });
    const content = '<img src="one.png"><img src="two.png"><img src="three.png">';
    const preview = (path = '/work/index.html', revision = 0, html = content) => <HtmlFilePreview sessionId="s" path={path} root="/work" content={html} revision={revision} />;
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(preview()); });
    try {
        expect(calls).toEqual(['/work/one.png']);
        await act(async () => {
            if (action === 'unmount') { renderer.unmount(); renderer = undefined; }
            else if (action === 'file change') renderer.update(preview('/work/next.html', 0, '<h1>Next file</h1>'));
            else renderer.update(preview('/work/index.html', 1));
        });
        const expected = action === 'refresh'
            ? ['/work/one.png', '/work/one.png', '/work/two.png', '/work/three.png']
            : ['/work/one.png'];
        expect(calls).toEqual(expected);
        await act(async () => { release(image); });
        expect(calls).toEqual(expected);
        if (renderer) expect(renderer.root.findByType('iframe').props.srcDoc).toContain(action === 'file change' ? 'Next file' : 'data:image/png;base64,aW1hZ2U=');
    } finally {
        if (renderer) await act(async () => { renderer.unmount(); });
    }
});
