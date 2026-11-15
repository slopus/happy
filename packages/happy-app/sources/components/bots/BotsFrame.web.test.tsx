import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { BotsFrame } from './BotsFrame.web';

vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (values: any) => values.web ?? values.default } }));

vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks');
    return { useUnistyles: () => ({ theme: { ...appThemes.ginghamDark } }) };
});

describe('Bots workspace mount boundary', () => {
    let tree: any, nodes: any[], host: object;
    const dispose = vi.fn(), mountRuntime = vi.fn((_host: unknown, _options: unknown) => dispose), authenticated = vi.fn(), failure = vi.fn();
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        vi.clearAllMocks(); nodes = []; host = { style: { setProperty: vi.fn() } };
        vi.stubGlobal('window', { PawsBots: { mount: mountRuntime } });
        vi.stubGlobal('document', {
            querySelector: (selector: string) => ({ content: selector.includes('entry') ? '/assets/bots/abc.js' : '/assets/bots/def.css' }),
            createElement: (tag: string) => ({ tag, remove: vi.fn() }),
            head: { appendChild: (node: any) => nodes.push(node) },
        });
    });
    afterEach(async () => { if (tree) await act(async () => tree.unmount()); tree = null; vi.unstubAllGlobals(); });
    const mount = async (expiresAt = Date.now() + 60_000) => {
        await act(async () => { tree = TestRenderer.create(<BotsFrame runtimeUrl="https://bots.example/" ticket={'s'.repeat(43)} expiresAt={expiresAt} onAuthenticated={authenticated} onFailure={failure} />, { createNodeMock: () => host }); });
    };
    it('mounts the local workspace into a div after styles load; no iframe or credential in DOM', async () => {
        await mount();
        expect(tree.root.findAllByType('iframe')).toHaveLength(0);
        expect(JSON.stringify(tree.root.findByType('div').props)).not.toContain('s'.repeat(43));
        const style = nodes[0]; expect(style.href).toBe('/assets/bots/def.css');
        await act(async () => style.onload());
        const script = nodes[1]; expect(script.src).toBe('/assets/bots/abc.js');
        await act(async () => script.onload());
        expect(mountRuntime).toHaveBeenCalledTimes(1);
        expect(mountRuntime.mock.calls[0][0]).toBe(host);
        const options = (mountRuntime.mock.calls as any)[0][1];
        expect(options.ticket).toBe('s'.repeat(43));
        const { appThemes } = await import('@/themePacks');
        expect(options.theme['--accent']).toBe(appThemes.ginghamDark.colors.surfaceSelected);
        expect(options.theme['--secondary']).toBe(appThemes.ginghamDark.colors.surfacePressed);
        expect(options.theme['--primary']).toBe(appThemes.ginghamDark.colors.button.primary.background);
        expect(options.theme['--overlay']).toBe(appThemes.ginghamDark.colors.modal.backdrop);
        await act(async () => tree.update(<BotsFrame {...tree.root.findByType(BotsFrame).props} />));
        expect(mountRuntime).toHaveBeenCalledTimes(1);
        expect(dispose).not.toHaveBeenCalled();
        await act(async () => tree.unmount()); tree = null;
        expect(dispose).toHaveBeenCalledOnce(); expect(style.remove).not.toHaveBeenCalled(); expect(script.remove).toHaveBeenCalledOnce();
    });
    it('ignores a late library load after leaving the screen', async () => {
        await mount(); const style = nodes[0];
        await act(async () => style.onload()); const script = nodes[1];
        await act(async () => tree.unmount()); tree = null;
        await act(async () => script.onload());
        expect(mountRuntime).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
    });
    it('fails closed for expired launches without calling the workspace', async () => {
        await mount(Date.now() - 1);
        await act(async () => nodes[0].onload());
        await act(async () => nodes[1].onload());
        expect(mountRuntime).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledOnce();
    });
    it('reuses scoped styles on return and executes a fresh isolated account runtime', async () => {
        await mount();
        expect(nodes).toHaveLength(2);
        await act(async () => { nodes[1].onload(); });
        expect(mountRuntime).not.toHaveBeenCalled();
        await act(async () => { nodes[0].onload(); });
        await act(async () => tree.unmount()); tree = null;
        await mount();
        expect(nodes).toHaveLength(3);
        expect(mountRuntime).toHaveBeenCalledTimes(1);
        await act(async () => { nodes[2].onload(); });
        expect(mountRuntime).toHaveBeenCalledTimes(2);
        expect(dispose).toHaveBeenCalledTimes(1);
    });
    it('does not poison retry after a resource fails', async () => {
        await mount();
        await act(async () => { nodes[0].onerror(); nodes[1].onload(); });
        expect(failure).toHaveBeenCalledOnce();
        expect(mountRuntime).not.toHaveBeenCalled();
        await act(async () => tree.unmount()); tree = null;
        await mount();
        expect(nodes).toHaveLength(4);
        await act(async () => { nodes[2].onload(); nodes[3].onload(); });
        expect(mountRuntime).toHaveBeenCalledOnce();
    });

});
