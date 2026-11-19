import { beforeEach, describe, expect, it, vi } from 'vitest';

const { read, externalRead } = vi.hoisted(() => ({ read: vi.fn(), externalRead: vi.fn() }));
vi.mock('@/sync/ops', () => ({
    sessionReadFile: externalRead,
    sessionWorkspaceReadFile: read,
    sessionWorkspaceWriteFile: vi.fn(),
}));
vi.mock('@/text', () => ({ t: (key: string, params?: { path: string }) => `${key}${params ? ':' + params.path : ''}` }));

import { readWorkspaceText } from './fileIO';

beforeEach(() => { read.mockReset(); externalRead.mockReset(); });

describe('workspace file reads', () => {
    it('decodes an empty or UTF-8 file and computes the content baseline', async () => {
        read.mockResolvedValueOnce({ success: true, content: '' });
        expect(await readWorkspaceText('session', '/project/empty.md')).toEqual({
            content: '', hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        });
        read.mockResolvedValueOnce({ success: true, content: Buffer.from('你好').toString('base64') });
        expect((await readWorkspaceText('session', '/project/doc.md')).content).toBe('你好');
    });
    it('explains the exact attempted path when a relative reference resolves to a missing file', async () => {
        read.mockResolvedValue({ success: false, error: "ENOENT: no such file or directory, realpath '/project/paws/operations/doc.md'" });
        await expect(readWorkspaceText('session', '/project/paws/operations/doc.md'))
            .rejects.toThrow('fileWorkspace.fileNotFound:/project/paws/operations/doc.md');
    });
    it('reports a bounded read timeout with a retry instruction', async () => {
        read.mockRejectedValue(Object.assign(new Error('RPC call timed out'), { name: 'TimeoutError' }));
        await expect(readWorkspaceText('session', '/project/doc.md')).rejects.toThrow('fileWorkspace.readTimeout');
    });
    it('preserves permission errors without treating them as a missing file', async () => {
        read.mockResolvedValue({ success: false, error: 'Access denied: symlink outside workspace' });
        await expect(readWorkspaceText('session', '/project/doc.md')).rejects.toThrow('Access denied: symlink outside workspace');
        expect(read).toHaveBeenCalledTimes(1);
    });
});

it('uses the existing read-only file RPC for outside-project references', async () => {
    externalRead.mockResolvedValue({ success: true, content: Buffer.from('# Skill').toString('base64') });
    expect((await readWorkspaceText('session', '/skills/SKILL.md', true)).content).toBe('# Skill');
    expect(externalRead).toHaveBeenCalledWith('session', '/skills/SKILL.md');
    expect(read).not.toHaveBeenCalled();
});
