import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { uploadMediaFile } from './uploadMediaFile.web';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('uploadMediaFile on web', () => {
    it('uploads the selected MP4 as a blob without converting it to an ArrayBuffer', async () => {
        const media = new Blob(['video-bytes'], { type: 'video/mp4' });
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(media, { status: 200 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await uploadMediaFile({
            ref: 'sessions/s1/attachments/video-id.mp4',
            uploadUrl: 'https://bucket.example/video-id.mp4?X-Amz-Signature=test',
            method: 'PUT',
        }, 'blob:https://app.example/local-video', 'video/mp4', {} as AuthCredentials);

        expect(fetchMock).toHaveBeenNthCalledWith(1, 'blob:https://app.example/local-video');
        expect(fetchMock).toHaveBeenNthCalledWith(2,
            'https://bucket.example/video-id.mp4?X-Amz-Signature=test',
            expect.objectContaining({
                method: 'PUT',
                body: media,
                headers: { 'Content-Type': 'video/mp4' },
            }),
        );
    });
});
