import { beforeEach, describe, expect, it, vi } from 'vitest';

const machineBash = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops', () => ({ machineBash }));

import { createWorktree } from './worktree';

describe('createWorktree', () => {
    beforeEach(() => machineBash.mockReset());

    it.each([
        'feature; touch /tmp/pwned #',
        '$(touch-pwned)',
        '../outside',
        '-force',
        'two words',
        'feature..name',
    ])('rejects unsafe user-entered name %j before contacting the machine', async (name) => {
        await expect(createWorktree('machine-1', '/repo', name)).resolves.toMatchObject({
            success: false,
            branchName: '',
        });
        expect(machineBash).not.toHaveBeenCalled();
    });

    it('uses a validated name for the branch and worktree path', async () => {
        machineBash
            .mockResolvedValueOnce({ success: true, stdout: '.git', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });

        await expect(createWorktree('machine-1', '/repo', 'feature.safe-1')).resolves.toEqual({
            success: true,
            worktreePath: '/repo/.dev/worktree/feature.safe-1',
            branchName: 'feature.safe-1',
            error: undefined,
        });
        expect(machineBash).toHaveBeenLastCalledWith(
            'machine-1',
            'git worktree add -b feature.safe-1 .dev/worktree/feature.safe-1',
            '/repo',
        );
    });

    it('keeps collision suffixes within the validated length limit', async () => {
        const name = `a${'b'.repeat(63)}`;
        machineBash
            .mockResolvedValueOnce({ success: true, stdout: '.git', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'already exists', exitCode: 128 })
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 });

        const result = await createWorktree('machine-1', '/repo', name);

        expect(result.success).toBe(true);
        expect(result.branchName).toHaveLength(64);
        expect(result.branchName).toMatch(/-2$/);
    });
});
