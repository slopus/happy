import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { requestAttachmentUpload, uploadEncryptedBlob, uploadMediaFile } from './attachmentUpload';

// Mirror the axios-mocking convention used in api.test.ts: a hoisted factory
// exposing default.{post,put}. The bare `vi.mock('axios')` automock is brittle
// here because axios is a default export with a complex shape, so we mock the
// surface we actually use.
const { mockPost, mockPut } = vi.hoisted(() => ({
    mockPost: vi.fn(),
    mockPut: vi.fn(),
}));

vi.mock('axios', () => ({
    default: {
        post: mockPost,
        put: mockPut,
    },
}));

beforeEach(() => {
    mockPost.mockReset();
    mockPut.mockReset();
});

describe('requestAttachmentUpload', () => {
    it('POSTs filename/size with bearer token and returns the upload descriptor', async () => {
        mockPost.mockResolvedValue({ data: { ref: 'sessions/s1/attachments/x.enc', uploadUrl: 'http://srv/up', method: 'PUT' } });
        const res = await requestAttachmentUpload('http://srv', 'tok', 's1', 'pic.png', 123);
        expect(res.ref).toBe('sessions/s1/attachments/x.enc');
        expect(res.method).toBe('PUT');
        const [url, body, cfg] = mockPost.mock.calls[0];
        expect(url).toBe('http://srv/v1/sessions/s1/attachments/request-upload');
        expect(body).toEqual({ filename: 'pic.png', size: 123 });
        expect(cfg.headers.Authorization).toBe('Bearer tok');
    });

    it('selects the video upload lane for generated MP4 artifacts', async () => {
        mockPost.mockResolvedValue({ data: { ref: 'sessions/s1/attachments/x.mp4', uploadUrl: 'https://s3.test/x', method: 'PUT' } });
        await requestAttachmentUpload('http://srv', 'tok', 's1', 'clip.mp4', 456, 'video');
        expect(mockPost.mock.calls[0][1]).toEqual({ filename: 'clip.mp4', size: 456, kind: 'video' });
    });
});

describe('uploadEncryptedBlob', () => {
    it('PUTs raw bytes to uploadUrl with bearer token for local-storage mode', async () => {
        mockPut.mockResolvedValue({ status: 200 });
        const bytes = new Uint8Array([1, 2, 3]);
        await uploadEncryptedBlob({ ref: 'r', uploadUrl: 'http://srv/up', method: 'PUT' }, bytes, 'tok');
        const [url, data, cfg] = mockPut.mock.calls[0];
        expect(url).toBe('http://srv/up');
        expect(data).toBe(bytes);
        expect(cfg.headers.Authorization).toBe('Bearer tok');
        expect(cfg.headers['Content-Type']).toBe('application/octet-stream');
    });

    it('throws on non-2xx', async () => {
        mockPut.mockResolvedValue({ status: 500 });
        await expect(
            uploadEncryptedBlob({ ref: 'r', uploadUrl: 'http://srv/up', method: 'PUT' }, new Uint8Array([1]), 'tok'),
        ).rejects.toThrow();
    });
});

describe('uploadMediaFile', () => {
    it('streams MP4 with its MIME type to presigned object storage', async () => {
        mockPut.mockResolvedValue({ status: 200 });
        const fixture = fileURLToPath(import.meta.url);
        await uploadMediaFile({
            ref: 'sessions/s1/attachments/clip.mp4',
            uploadUrl: 'https://s3.test/clip.mp4?X-Amz-Signature=sig',
            method: 'PUT',
        }, fixture, 123, 'video/mp4', 'tok');

        const [, stream, cfg] = mockPut.mock.calls[0];
        expect(cfg.headers['Content-Type']).toBe('video/mp4');
        expect(cfg.headers.Authorization).toBeUndefined();
        expect(cfg.proxy).toBe(false);
        stream.destroy();
    });

    it('keeps bearer auth for a server-hosted media upload', async () => {
        mockPut.mockResolvedValue({ status: 200 });
        const fixture = fileURLToPath(import.meta.url);
        await uploadMediaFile({ ref: 'r', uploadUrl: 'http://srv/up', method: 'PUT' }, fixture, 123, 'video/mp4', 'tok');
        const [, stream, cfg] = mockPut.mock.calls[0];
        expect(cfg.headers.Authorization).toBe('Bearer tok');
        expect(cfg.headers['Content-Type']).toBe('application/octet-stream');
        expect(cfg.proxy).toBeUndefined();
        stream.destroy();
    });
});
