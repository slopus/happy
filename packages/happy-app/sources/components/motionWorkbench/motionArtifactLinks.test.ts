import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: true, server: 'https://paws.test', generation: 'g1', sessions: {} as Record<string, any>, update: vi.fn(), apply: vi.fn() }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: () => { if (!state.current) throw new Error('Account changed'); }, getRuntimeAccountSelection: () => ({ key: 'account', generation: state.generation, serverUrl: state.server }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => state.server }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: state.sessions, applySessions: state.apply }) } }));
vi.mock('@/sync/ops', () => ({ sessionUpdateMetadata: state.update }));
import { linkMotionProject, loadMotionLinks, unlinkMotionProject } from './motionArtifactLinks.web';
const project = (letter = 'a') => ({ projectId: letter.repeat(64), projectPath: '/work/film-' + letter, title: 'Film ' + letter });
const link = (letter = 'a', workspaceRoot = '/work') => ({ ...project(letter), projectPath: workspaceRoot + '/film-' + letter, workspaceRoot, linkedAt: 10 });
beforeEach(() => {
 state.current = true; state.server = 'https://paws.test'; state.generation = 'g1';
 state.sessions = { session: { id: 'session', metadata: { path: '/work', machineId: 'machine', foreignField: { keep: true } }, metadataVersion: 1 } };
 state.apply.mockReset().mockImplementation((sessions: any[]) => { for (const session of sessions) state.sessions[session.id] = session; });
 state.update.mockReset().mockImplementation(async (_id, metadata, version, update, _retries, assertCurrent) => { assertCurrent(); const next = update(metadata); assertCurrent(); return { metadata: next, version: version + 1 }; });
});
it('loads only explicit valid references belonging to the selected workspace', () => {
 expect(loadMotionLinks({ motionProjectLinks: [link(), link('b', '/another'), { ...link('c'), projectPath: '/outside/film' }, { broken: true }] }, '/work/')).toEqual([link()]);
 expect(loadMotionLinks({ path: '/work' }, '/work')).toEqual([]);
});
it('merges encrypted CAS retries without deleting another device fields or references', async () => {
 state.update.mockImplementation(async (_id, metadata, version, update, _retries, assertCurrent) => { assertCurrent(); update(metadata); return { version: version + 2, metadata: update({ ...metadata, anotherDevice: 'keep', motionProjectLinks: [link('b')] }) }; });
 await linkMotionProject('session', project());
 expect(state.sessions.session.metadata).toMatchObject({ foreignField: { keep: true }, anotherDevice: 'keep' });
 expect(loadMotionLinks(JSON.parse(JSON.stringify(state.sessions.session.metadata)), '/work')).toHaveLength(2);
 expect(state.update.mock.calls[0][5]).toEqual(expect.any(Function));
});
it('serializes simultaneous local associations without overwriting either one', async () => {
 await Promise.all([linkMotionProject('session', project('a')), linkMotionProject('session', project('b'))]);
 expect(loadMotionLinks(state.sessions.session.metadata)).toHaveLength(2); expect(state.update.mock.calls[1][2]).toBe(2);
});
it('unlinks only this conversation and preserves other references and unknown metadata', async () => {
 state.sessions.session.metadata.motionProjectLinks = [link(), link('b')];
 state.sessions.other = { metadata: { path: '/work', machineId: 'machine', motionProjectLinks: [link()] } };
 await unlinkMotionProject('session', 'a'.repeat(64));
 expect(loadMotionLinks(state.sessions.session.metadata)).toEqual([link('b')]); expect(loadMotionLinks(state.sessions.other.metadata)).toEqual([link()]);
 expect(state.sessions.session.metadata.foreignField).toEqual({ keep: true });
});
it.each(['account', 'server', 'workspace', 'machine', 'deleted'])('blocks a late write after its %s owner changes', async reason => {
 state.update.mockImplementation(async (_id, metadata, version, update, _retries, assertCurrent) => {
  update(metadata); if (reason === 'account') state.generation = 'g2'; if (reason === 'server') state.server = 'https://another.test';
  if (reason === 'workspace') state.sessions.session.metadata.path = '/changed'; if (reason === 'machine') state.sessions.session.metadata.machineId = 'other'; if (reason === 'deleted') delete state.sessions.session;
  assertCurrent(); return { metadata, version: version + 1 };
 });
 await expect(linkMotionProject('session', project())).rejects.toThrow(); expect(state.apply).not.toHaveBeenCalled();
});
it('does not replace a newer received metadata version with a delayed response', async () => {
 state.update.mockImplementation(async (_id, metadata, _version, update) => { const next = update(metadata); state.sessions.session = { ...state.sessions.session, metadataVersion: 9, metadata: { ...metadata, newer: true } }; return { metadata: next, version: 2 }; });
 await linkMotionProject('session', project()); expect(state.apply).not.toHaveBeenCalled(); expect(state.sessions.session.metadata.newer).toBe(true);
});
it('rejects sibling and traversal references before writing metadata', async () => {
 await expect(linkMotionProject('session', { ...project(), projectPath: '/work-sibling/film' })).rejects.toThrow('inside');
 await expect(linkMotionProject('session', { ...project(), projectPath: '/work/../outside' })).rejects.toThrow('inside'); expect(state.apply).not.toHaveBeenCalled();
});
it('keeps the original association timestamp when its title changes', async () => {
 state.sessions.session.metadata.motionProjectLinks = [link()]; await linkMotionProject('session', { ...project(), title: 'Renamed' }); expect(loadMotionLinks(state.sessions.session.metadata)).toEqual([{ ...link(), title: 'Renamed' }]);
});

const numberedLinks = (count: number) => Array.from({ length: count }, (_, index) => ({
 projectId: index.toString(16).padStart(64, '0'), projectPath: '/work/film-' + index,
 title: 'Existing film ' + index, workspaceRoot: '/work', linkedAt: index,
}));
it('persists exactly 20 links and rejects the 21st before invoking metadata emission', async () => {
 const existing = numberedLinks(19);
 state.sessions.session.metadata.motionProjectLinks = existing;
 await linkMotionProject('session', project('a'));
 expect(state.sessions.session.metadata.motionProjectLinks).toHaveLength(20);
 expect(state.sessions.session.metadata.motionProjectLinks.slice(0, 19)).toEqual(existing);
 expect(state.update).toHaveBeenCalledOnce();
 const saved = state.sessions.session.metadata;
 await expect(linkMotionProject('session', project('b'))).rejects.toThrow('at most 20');
 expect(state.update).toHaveBeenCalledOnce(); expect(state.apply).toHaveBeenCalledOnce();
 expect(state.sessions.session.metadata).toBe(saved);
 // Updating the title of an existing reference at capacity remains allowed.
 await linkMotionProject('session', { ...project('a'), title: 'Existing at capacity' });
 expect(state.sessions.session.metadata.motionProjectLinks).toHaveLength(20);
 expect(loadMotionLinks(state.sessions.session.metadata).find(row => row.projectId === project('a').projectId)?.title).toBe('Existing at capacity');
});
it('rechecks the 20-link boundary after a remote addition wins the metadata CAS', async () => {
 const existing = numberedLinks(19), concurrent = { ...link('c'), title: 'Other device reference' };
 state.sessions.session.metadata.motionProjectLinks = existing;
 const emit = vi.fn();
 state.update.mockImplementation(async (_id, metadata, version, update) => {
  update(metadata); // The initial 19 + this requested reference would fit.
  const latest = { ...metadata, motionProjectLinks: [...existing, concurrent] };
  state.sessions.session = { ...state.sessions.session, metadata: latest, metadataVersion: version + 1 };
  const next = update(latest); // Must reject 21 before encrypting/emitting again.
  emit(next); return { metadata: next, version: version + 2 };
 });
 await expect(linkMotionProject('session', project('a'))).rejects.toThrow('at most 20');
 expect(emit).not.toHaveBeenCalled(); expect(state.apply).not.toHaveBeenCalled();
 expect(state.sessions.session.metadata.motionProjectLinks).toEqual([...existing, concurrent]);
});
it('counts retained links from older workspace roots without evicting them to make room', async () => {
 const existing = numberedLinks(19).map(row => ({ ...row, workspaceRoot: '/previous', projectPath: row.projectPath.replace('/work/', '/previous/') }));
 state.sessions.session.metadata.motionProjectLinks = [...existing, link('a')];
 await expect(linkMotionProject('session', project('b'))).rejects.toThrow('at most 20');
 expect(state.update).not.toHaveBeenCalled(); expect(state.sessions.session.metadata.motionProjectLinks).toEqual([...existing, link('a')]);
});

it('preserves future worker fields inside stored link envelopes while stripping unknown incoming command fields', async () => {
 const futureWorkerState = { identityVersion: 2, capabilities: ['review'], nested: { preserve: true } };
 state.sessions.session.metadata.motionProjectLinks = [{ ...link(), futureWorkerState }];
 expect(loadMotionLinks(state.sessions.session.metadata)).toEqual([{ ...link(), futureWorkerState }]);
 // A thin browser reference may update known fields, never replace future worker data.
 await linkMotionProject('session', { ...project(), title: 'Renamed by user', futureWorkerState: 'untrusted override', unknownCommandField: 'do not store' } as any);
 expect(state.sessions.session.metadata.motionProjectLinks).toEqual([{ ...link(), title: 'Renamed by user', futureWorkerState }]);
 await linkMotionProject('session', { ...project('b'), unknownCommandField: 'do not store' } as any);
 expect(state.sessions.session.metadata.motionProjectLinks[0]).toEqual({ ...link(), title: 'Renamed by user', futureWorkerState });
 expect(state.sessions.session.metadata.motionProjectLinks[1]).not.toHaveProperty('unknownCommandField');
 expect(state.sessions.session.metadata.foreignField).toEqual({ keep: true });
});
