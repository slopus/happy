import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import {
    downloadProjectAvatar,
    fetchProjects,
    requestProjectAvatarDownload,
} from './apiProjects';

vi.mock('./serverConfig', () => ({
    getServerUrl: () => 'https://api.example.test',
    rewriteLoopbackHost: (url: string) => url,
}));

vi.mock('./apiSocket', () => ({
    getHappyClientId: () => 'happy-test',
}));

const credentials: AuthCredentials = {
    token: 'token-1',
    secret: 'secret-1',
};

function response(body: unknown, options: { ok?: boolean; status?: number; bytes?: Uint8Array } = {}) {
    return {
        ok: options.ok ?? true,
        status: options.status ?? 200,
        json: async () => body,
        arrayBuffer: async () => (options.bytes ?? new Uint8Array([1, 2, 3])).buffer,
    };
}

describe('project API transport', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('accepts the opaque project catalog contract without a data/avatar payload', async () => {
        fetchMock.mockResolvedValueOnce(response({
            projects: [{
                id: 'project-1',
                externalId: 'repo-1',
                metadata: 'metadata-ciphertext',
                metadataVersion: 3,
                dataEncryptionKey: 'wrapped-project-key',
                avatar: { ref: 'projects/project-1/avatar/a.enc', preview: 'preview-ciphertext', version: 4 },
                createdAt: 10,
                updatedAt: 20,
            }],
        }));

        await expect(fetchProjects(credentials, ['project-1'])).resolves.toEqual([{
            id: 'project-1',
            externalId: 'repo-1',
            metadata: 'metadata-ciphertext',
            metadataVersion: 3,
            dataEncryptionKey: 'wrapped-project-key',
            avatar: { ref: 'projects/project-1/avatar/a.enc', preview: 'preview-ciphertext', version: 4 },
            createdAt: 10,
            updatedAt: 20,
        }]);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v1/projects?ids=project-1',
            expect.any(Object),
        );
    });

    it('does not hit the project API when no session references a project', async () => {
        await expect(fetchProjects(credentials, [])).resolves.toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('requests the server-resolved current avatar with no body or client ref', async () => {
        fetchMock.mockResolvedValueOnce(response({ downloadUrl: 'https://files.example.test/avatar.enc' }));

        await expect(requestProjectAvatarDownload(credentials, 'project/1')).resolves.toBe(
            'https://files.example.test/avatar.enc',
        );

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.example.test/v1/projects/project%2F1/avatar/request-download',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
            }),
        );
        expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body');
    });

    it('sends Bearer only for a server-hosted download URL', async () => {
        fetchMock
            .mockResolvedValueOnce(response({ downloadUrl: 'https://cdn.example.test/avatar.enc?sig=private' }))
            .mockResolvedValueOnce(response(null, { bytes: new Uint8Array([9, 8]) }));

        await expect(downloadProjectAvatar(credentials, 'project-1')).resolves.toEqual(new Uint8Array([9, 8]));
        expect(fetchMock.mock.calls[1][1]).toBeUndefined();

        fetchMock.mockReset();
        fetchMock
            .mockResolvedValueOnce(response({ downloadUrl: 'https://api.example.test/v1/private/avatar' }))
            .mockResolvedValueOnce(response(null, { bytes: new Uint8Array([7]) }));

        await downloadProjectAvatar(credentials, 'project-1');
        expect(fetchMock.mock.calls[1][1]).toEqual({
            headers: { Authorization: 'Bearer token-1', 'X-Happy-Client': 'happy-test' },
        });
    });
});