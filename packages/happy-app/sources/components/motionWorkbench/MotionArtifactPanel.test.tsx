import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: true, online: true, sessionId: 'session', rpc: vi.fn(), open: vi.fn(), files: vi.fn(), setReference: vi.fn(), link: vi.fn(), unlink: vi.fn(), confirm: vi.fn(), session: { metadata: { machineId: 'machine', path: '/work', motionProjectLinks: [] as any[] } } }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', TextInput: 'TextInput' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'text', textSecondary: 'secondary', textDestructive: 'error', divider: 'divider', surface: 'surface', input: { background: 'input', text: 'text' } } } }) }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/DesktopDialogFrame', () => ({ DesktopDialogFrame: ({ visible, ...props }: any) => visible ? React.createElement('Dialog', props) : null }));
vi.mock('@/components/fileWorkspace/WorkspaceButton', () => ({ WorkspaceButton: 'Button' }));
vi.mock('@/components/fileWorkspace/context', () => ({ useFileWorkspace: () => ({ sessionId: state.sessionId, root: '/work', enabled: true, openMotionProject: state.open, openReference: state.files, setReference: state.setReference }) }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => state.current, getRuntimeAccountSelection: () => ({ key: 'account', generation: 'g1' }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://paws.test' }));
vi.mock('@/sync/storage', () => ({ useSession: () => state.session, useSocketStatus: () => ({ status: state.online ? 'connected' : 'disconnected' }), storage: { getState: () => ({ sessions: { [state.sessionId]: state.session } }) } }));
vi.mock('@/utils/sessionUtils', () => ({ resolveSessionState: () => ({ isConnected: true }) }));
vi.mock('@/sync/motionWorkbench.web', () => ({ motionWorkbenchRequest: state.rpc }));
vi.mock('./motionArtifactLinks.web', () => ({ loadMotionLinks: (metadata: any) => metadata?.motionProjectLinks ?? [], linkMotionProject: state.link, unlinkMotionProject: state.unlink }));
vi.mock('@/modal', () => ({ Modal: { confirm: state.confirm } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'zh-Hans' }));
import { MotionArtifactPanel } from './MotionArtifactPanel.web';
const movie = { projectId: 'a'.repeat(64), projectPath: '/work/film', title: 'Named film', modifiedAt: 1 };
const linked = { ...movie, workspaceRoot: '/work', linkedAt: 1 };
let renderer: any;
beforeEach(() => {
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; state.current = true; state.online = true; state.sessionId = 'session'; state.session = { metadata: { machineId: 'machine', path: '/work', motionProjectLinks: [] } };
 state.rpc.mockReset().mockImplementation(async (_session, method) => method === 'motionWorkbenchList' ? { projects: [movie], truncated: false } : method === 'motionWorkbenchInspect' ? { ...movie, documentRevision: 7, buildId: 'build', markerVersion: 'markers', snapshotHash: 'b'.repeat(64) } : movie);
 state.open.mockReset().mockResolvedValue(undefined); state.files.mockReset().mockResolvedValue(undefined); state.setReference.mockReset(); state.link.mockReset().mockResolvedValue(linked); state.unlink.mockReset().mockResolvedValue(undefined); state.confirm.mockReset().mockResolvedValue(true);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });
async function mount(mode: 'summary' | 'library' = 'summary') { await act(async () => { renderer = TestRenderer.create(<MotionArtifactPanel sessionId={state.sessionId} mode={mode} />); }); }
const button = (id: string) => renderer.root.findByProps({ testID: id });
async function library() { await mount('library'); await act(async () => button('motion-artifacts-open').props.onPress()); }
it.each(['summary', 'library'] as const)('does not scan or associate an ordinary conversation on %s mount', async mode => {
 await mount(mode); expect(state.rpc).not.toHaveBeenCalled(); expect(state.link).not.toHaveBeenCalled(); expect(renderer.root.findAllByProps({ testID: 'motion-artifact:' + movie.projectId })).toHaveLength(0);
 await act(async () => button('motion-artifacts-open').props.onPress()); expect(button('motion-candidate:' + movie.projectId)).toBeDefined(); expect(state.link).not.toHaveBeenCalled(); expect(state.open).not.toHaveBeenCalled();
});
it('opens a verified candidate without selecting or associating it', async () => {
 await library(); await act(async () => button('motion-candidate-open:' + movie.projectId).props.onPress()); expect(state.open).toHaveBeenCalledExactlyOnceWith(movie.projectPath); expect(state.link).not.toHaveBeenCalled(); expect(state.setReference).not.toHaveBeenCalled();
});
it('associates only on explicit action and does not make it the AI target', async () => {
 await library(); await act(async () => button('motion-artifact-link:' + movie.projectId).props.onPress()); expect(state.link).toHaveBeenCalledExactlyOnceWith('session', movie); expect(state.setReference).not.toHaveBeenCalled(); expect(state.open).not.toHaveBeenCalled(); expect(JSON.stringify(renderer.toJSON())).toContain('还未选择为本次修改对象');
});
it('freezes the freshly inspected native version into the current target', async () => {
 state.session.metadata.motionProjectLinks = [linked]; await mount(); await act(async () => button('motion-artifact-target:' + movie.projectId).props.onPress());
 expect(state.setReference).toHaveBeenCalledExactlyOnceWith({ path: movie.projectPath + '/mh.json', hash: 'b'.repeat(64), motion: { projectId: movie.projectId, projectPath: movie.projectPath, title: movie.title, documentRevision: 7, buildId: 'build', markerVersion: 'markers', snapshotHash: 'b'.repeat(64) } });
});
it('unlinks after confirmation and clears only the matching current target', async () => {
 state.session.metadata.motionProjectLinks = [linked]; await mount(); await act(async () => button('motion-artifact-unlink:' + movie.projectId).props.onPress()); expect(state.unlink).toHaveBeenCalledExactlyOnceWith('session', movie.projectId); expect(state.open).not.toHaveBeenCalled();
 const update = state.setReference.mock.calls[0][0]; expect(update({ motion: { projectId: movie.projectId } })).toBeNull(); const other = { motion: { projectId: 'c'.repeat(64) } }; expect(update(other)).toBe(other);
});
it('does not open after its conversation changes during validation', async () => {
 await library(); let finish!: (value: unknown) => void; state.rpc.mockReturnValueOnce(new Promise(done => { finish = done; })); act(() => { button('motion-candidate-open:' + movie.projectId).props.onPress(); });
 state.sessionId = 'other'; await act(async () => renderer.update(<MotionArtifactPanel sessionId="other" />)); await act(async () => { finish(movie); }); expect(state.open).not.toHaveBeenCalled();
});
it('disables the generic entry while the execution session is offline', async () => { state.online = false; await mount(); expect(button('motion-artifacts-open').props.disabled).toBe(true); expect(state.rpc).not.toHaveBeenCalled(); });
