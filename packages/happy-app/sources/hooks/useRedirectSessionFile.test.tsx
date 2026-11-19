import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ web: true, width: 1400, root: '/work', navigate: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return state.web ? 'web' : 'android'; } }, useWindowDimensions: () => ({ width: state.width }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: state.navigate }) }));
vi.mock('@/sync/storage', () => ({ useSession: () => ({ metadata: { path: state.root } }) }));
import { useRedirectSessionFile } from './useRedirectSessionFile';
import { decodeFilePath } from '@/utils/filePathEncoding';
let redirect = false;
function Probe({ path = '/work/PRIVACY.md', line, column }: { path?: string; line?: string; column?: string }) {
    redirect = useRedirectSessionFile('s', path, { line, column }); return null;
}
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; state.web = true; state.width = 1400; state.root = '/work'; state.navigate.mockClear(); });
it('redirects an old desktop file URL back to its conversation once', () => {
    let r: any; act(() => { r = TestRenderer.create(<Probe />); });
    expect(redirect).toBe(true); expect(state.navigate.mock.calls[0][0].params.id).toBe('s');
    act(() => r.update(<Probe />)); expect(state.navigate).toHaveBeenCalledTimes(1); act(() => r.unmount());
});
it('carries query line and column into the desktop workspace instead of mounting the old reader', () => {
    let r: any; act(() => { r = TestRenderer.create(<Probe line="12" column="4" />); });
    expect(redirect).toBe(true);
    expect(decodeFilePath(state.navigate.mock.calls[0][0].params.openFile)).toBe('/work/PRIVACY.md:12:4');
    act(() => r.unmount());
});
it('keeps the old reader unmounted while cold-start session metadata is hydrating', () => {
    state.root = ''; let r: any; act(() => { r = TestRenderer.create(<Probe />); });
    expect(redirect).toBe(true); expect(state.navigate).not.toHaveBeenCalled();
    state.root = '/work'; act(() => r.update(<Probe />)); expect(state.navigate).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
});
it.each([{ web: false, width: 1400 }, { web: true, width: 1099 }])('retains native and small-screen readers: %o', config => {
    Object.assign(state, config); let r: any; act(() => { r = TestRenderer.create(<Probe line="5" />); });
    expect(redirect).toBe(false); expect(state.navigate).not.toHaveBeenCalled(); act(() => r.unmount());
});
it('redirects external files too', () => {
    let r: any; act(() => { r = TestRenderer.create(<Probe path="/skills/SKILL.md" />); });
    expect(redirect).toBe(true); expect(state.navigate.mock.calls[0][0].params.id).toBe('s'); act(() => r.unmount());
});
