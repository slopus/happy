import { describe, expect, it, vi } from 'vitest';
import type { GoalProject, GoalBoardSnapshot } from '@slopus/happy-wire';
import { findSessionWorkspace, sessionWorkspaceRoute } from './sessionWorkspaceRoute';

const projects: GoalProject[] = [{ projectPath: '/archive/p', title: 'Project', features: [
    { featurePath: '/archive/p/features/f', title: 'Feature' },
] }];
const featurePath = '/archive/p/features/f';
const board = { snapshot: { featurePath, tasks: [
    { id: 'GFT-12345678', indexPath: `${featurePath}/tasks/02-Task/index.md` },
] } as GoalBoardSnapshot };
const metadata = { machineId: 'machine', path: `${featurePath}/tasks/02-Task` };

describe('ordinary conversation to its workspace', () => {
    it('uses the exact current session, project and recorded task ID from a legacy task directory', async () => {
        const read = vi.fn().mockResolvedValue(board);
        const route = await sessionWorkspaceRoute('older-session', metadata, projects, read);
        expect(route).toEqual({ pathname: '/projects', params: { machine: 'machine', project: '/archive/p', feature: featurePath,
            task: 'GFT-12345678', conversation: 'older-session', author: undefined, view: 'chat', file: undefined } });
        expect(read).toHaveBeenCalledExactlyOnceWith('machine', featurePath);
    });
    it('explicit ownership takes precedence over a coincidentally shared directory', async () => {
        const read = vi.fn().mockResolvedValue(board);
        const route = await sessionWorkspaceRoute('s', { ...metadata, path: '/elsewhere', goalBoard: { featurePath, taskId: 'GFT-12345678' } }, projects, read);
        expect(route?.params.task).toBe('GFT-12345678');
        expect(route?.params.conversation).toBe('s');
    });
    it.each(['/archive/p', featurePath])('restores a global conversation at %s via the shared desktop/mobile author parameter', async path => {
        const read = vi.fn();
        const route = await sessionWorkspaceRoute('global-old', { machineId: 'machine', path }, projects, read);
        expect(route?.params).toMatchObject({ project: '/archive/p', author: 'global-old', conversation: undefined, task: undefined });
        expect(route?.params.feature).toBe(path === featurePath ? featurePath : undefined);
        expect(read).not.toHaveBeenCalled();
    });
    it('honors explicit global ownership without interpreting its cwd as a task', async () => {
        const route = await sessionWorkspaceRoute('s', { ...metadata, goalBoard: { featurePath } }, projects, vi.fn());
        expect(route?.params).toMatchObject({ author: 's', task: undefined });
    });
    it('never falls back from stale explicit ownership to a matching directory or another task', async () => {
        expect(await sessionWorkspaceRoute('s', { ...metadata, goalBoard: { featurePath: '/missing', taskId: 't' } }, projects, vi.fn())).toBeNull();
        expect(await sessionWorkspaceRoute('s', { ...metadata, goalBoard: { featurePath, taskId: 'removed' } }, projects, vi.fn().mockResolvedValue(board))).toBeNull();
    });
    it.each(['/unrelated', `${featurePath}/tasks/removed`, `${featurePath}/tasks/02-Task/inputs`, `${featurePath}-other/tasks/02-Task`])('rejects non-owned cwd %s', async path => {
        expect(await sessionWorkspaceRoute('s', { ...metadata, path }, projects, vi.fn().mockResolvedValue(board))).toBeNull();
    });
    it('fails closed on read errors or a board from another goal', async () => {
        await expect(sessionWorkspaceRoute('s', metadata, projects, vi.fn().mockRejectedValue(new Error('offline')))).rejects.toThrow('offline');
        expect(await sessionWorkspaceRoute('s', metadata, projects, vi.fn().mockResolvedValue({ snapshot: { ...board.snapshot, featurePath: '/wrong' } }))).toBeNull();
    });
    it('does not match a title or an unowned machine', () => {
        expect(findSessionWorkspace({ path: 'Project' }, projects)).toBeNull();
        expect(findSessionWorkspace({ machineId: 'm', path: 'Feature' }, projects)).toBeNull();
    });
    it('normalizes separator and trailing slash differences without using path substrings as identity', async () => {
        const route = await sessionWorkspaceRoute('s', { ...metadata, path: metadata.path.replaceAll('/', '\\') + '\\' }, projects, vi.fn().mockResolvedValue(board));
        expect(route?.params.task).toBe('GFT-12345678');
    });
});
