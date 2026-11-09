import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ web: true, desktop: true, workspace: null as any, push: vi.fn(), navigate: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return state.web ? 'web' : 'android'; } }, useWindowDimensions: () => ({ width: 1400 }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push, navigate: state.navigate }) }));
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({ useDesktopWorkspaceLayout: () => ({ enabled: state.desktop, rightPanelAvailable: false }) }));
vi.mock('@/components/fileWorkspace/context', () => ({ useFileWorkspace: () => state.workspace }));
import { useOpenSessionFile } from './useOpenSessionFile';
import { decodeFilePath } from '@/utils/filePathEncoding';
let open: ReturnType<typeof useOpenSessionFile>;
function Probe({ sessionId = 's' }: { sessionId?: string }) { open = useOpenSessionFile(sessionId); return null; }
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; state.web = true; state.desktop = true; state.workspace = null; vi.clearAllMocks(); });
it('opens project files in the current session workspace without navigating away from chat', () => {
    const openReference = vi.fn(); state.workspace = { sessionId: 's', enabled: true, root: '/work', openReference };
    let renderer: any; act(() => { renderer = TestRenderer.create(<Probe />); });
    act(() => open('/work/PRIVACY.md'));
    expect(openReference).toHaveBeenCalledWith('/work/PRIVACY.md');
    expect(state.push).not.toHaveBeenCalled(); expect(state.navigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});
it('hands desktop files opened outside the workspace context to their owning session', () => {
    let renderer: any; act(() => { renderer = TestRenderer.create(<Probe />); });
    act(() => open('/work/中文 文档.md'));
    const href = state.navigate.mock.calls[0][0];
    expect(href.pathname).toBe('/session/[id]'); expect(href.params.id).toBe('s');
    expect(decodeFilePath(href.params.openFile)).toBe('/work/中文 文档.md');
    const firstRequest = href.params.fileOpenRequest;
    act(() => open('/work/中文 文档.md'));
    expect(state.navigate.mock.calls[1][0].params.fileOpenRequest).not.toBe(firstRequest);
    act(() => renderer.unmount());
});
it('never opens a different session file in the current workspace', () => {
    const openReference = vi.fn(); state.workspace = { sessionId: 'other', enabled: true, root: '/work', openReference };
    let renderer: any; act(() => { renderer = TestRenderer.create(<Probe />); });
    act(() => open('/work/a.md'));
    expect(openReference).not.toHaveBeenCalled(); expect(state.navigate.mock.calls[0][0].params.id).toBe('s');
    act(() => renderer.unmount());
});
it('retains the independent viewer for files outside the current authorized project', () => {
    state.workspace = { sessionId: 's', enabled: true, root: '/work', openReference: vi.fn() };
    let renderer: any; act(() => { renderer = TestRenderer.create(<Probe />); });
    act(() => open('/other/a.md'));
    expect(state.push.mock.calls[0][0]).toContain('/session/s/file?path='); expect(state.navigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});
it.each([{web:false,desktop:true},{web:true,desktop:false}])('keeps the existing small-screen/native viewer: %o', config => {
    Object.assign(state, config);
    let renderer: any; act(() => { renderer = TestRenderer.create(<Probe />); });
    act(() => open('/work/a.md'));
    expect(state.push.mock.calls[0][0]).toContain('/session/s/file?path='); expect(state.navigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});
