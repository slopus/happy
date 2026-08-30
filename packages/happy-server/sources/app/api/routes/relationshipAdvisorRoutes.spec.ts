import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Fastify } from '@/app/api/types';

const filesMock = vi.hoisted(() => ({
    isLocalStorage: vi.fn(() => true),
    putLocalFile: vi.fn(async () => undefined),
    s3bucket: 'test-bucket',
    s3client: {
        newPostPolicy: vi.fn(),
        presignedPostPolicy: vi.fn(),
    },
}));
const deleteImagesMock = vi.hoisted(() => vi.fn(async () => undefined));
const openImageWriteRuntimeMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/storage/files', () => filesMock);
vi.mock('@/modules/relationship-advisor/relationshipAdvisorImages', () => ({
    deleteRelationshipAdvisorImages: deleteImagesMock,
}));
vi.mock('@/modules/relationship-advisor/relationshipAdvisorPlugin', () => ({
    relationshipAdvisorPlugin: {
        openImageWriteRuntime: openImageWriteRuntimeMock,
    },
}));

import { relationshipAdvisorRoutes } from '@/app/api/routes/relationshipAdvisorRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    relationshipAdvisorRoutes(typed);
    await typed.ready();
    return typed;
}

describe('relationshipAdvisorRoutes', () => {
    let app: Fastify;
    beforeEach(() => {
        filesMock.isLocalStorage.mockReturnValue(true);
        openImageWriteRuntimeMock.mockResolvedValue(undefined);
    });
    afterEach(async () => {
        if (app) await app.close();
        vi.clearAllMocks();
    });

    it('creates a user-scoped plaintext image upload in local storage mode', async () => {
        app = await createApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/relationship-advisor/images/request-upload',
            headers: {
                'x-user-id': 'user-1',
                host: 'happy.test',
                'x-forwarded-proto': 'https',
            },
            payload: { mimeType: 'image/jpeg', size: 1_024 },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            ref: expect.stringMatching(/^advisor\/user-1\/[a-f0-9-]+\.jpg$/),
            uploadUrl: expect.stringMatching(/^https:\/\/happy\.test\/v1\/relationship-advisor\/images\/[a-f0-9-]+\.jpg$/),
            method: 'PUT',
        });
        expect(openImageWriteRuntimeMock).toHaveBeenCalledWith('user-1');
    });

    it('returns a size-limited presigned POST in S3 mode', async () => {
        filesMock.isLocalStorage.mockReturnValue(false);
        const policy = {
            key: '',
            maxSize: 0,
            setBucket: vi.fn(),
            setKey(value: string) { policy.key = value; },
            setExpires: vi.fn(),
            setContentLengthRange(_minimum: number, maximum: number) { policy.maxSize = maximum; },
        };
        filesMock.s3client.newPostPolicy.mockReturnValue(policy);
        filesMock.s3client.presignedPostPolicy.mockResolvedValue({
            postURL: 'https://oss.test/upload',
            formData: { key: 'server-generated', policy: 'signed-policy' },
        });
        app = await createApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/relationship-advisor/images/request-upload',
            headers: { 'x-user-id': 'user-1' },
            payload: { mimeType: 'image/webp', size: 2_048 },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            ref: expect.stringMatching(/^advisor\/user-1\/[a-f0-9-]+\.webp$/),
            uploadUrl: 'https://oss.test/upload',
            method: 'POST',
            formFields: { key: 'server-generated', policy: 'signed-policy' },
        });
        expect(policy.key).toMatch(/^advisor\/user-1\/[a-f0-9-]+\.webp$/);
        expect(policy.maxSize).toBe(10 * 1024 * 1024);
    });

    it('accepts the raw plaintext image only for the authenticated user in local mode', async () => {
        app = await createApp();
        const requestUpload = await app.inject({
            method: 'POST',
            url: '/v1/relationship-advisor/images/request-upload',
            headers: { 'x-user-id': 'user-1', host: 'happy.test' },
            payload: { mimeType: 'image/png', size: 4 },
        });
        const uploadUrl = new URL(requestUpload.json().uploadUrl);

        const response = await app.inject({
            method: 'PUT',
            url: uploadUrl.pathname,
            headers: {
                'x-user-id': 'user-1',
                'content-type': 'application/octet-stream',
            },
            payload: Buffer.from([1, 2, 3, 4]),
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        expect(filesMock.putLocalFile).toHaveBeenCalledWith(
            expect.stringMatching(/^advisor\/user-1\/[a-f0-9-]+\.png$/),
            Buffer.from([1, 2, 3, 4]),
        );
        expect(openImageWriteRuntimeMock).toHaveBeenLastCalledWith('user-1');
    });

    it('discards uploaded image refs through the authenticated owner boundary', async () => {
        app = await createApp();
        const refs = ['advisor/user-1/12345678-1234-1234-1234-123456789abc.jpg'];

        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/relationship-advisor/images',
            headers: { 'x-user-id': 'user-1' },
            payload: { refs },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        expect(deleteImagesMock).toHaveBeenCalledWith('user-1', refs);
        expect(openImageWriteRuntimeMock).toHaveBeenCalledWith('user-1');
    });

    it('does not issue or persist image writes when the capability broker denies access', async () => {
        openImageWriteRuntimeMock.mockRejectedValue(new Error('plugin not installed'));
        app = await createApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v1/relationship-advisor/images/request-upload',
            headers: { 'x-user-id': 'user-1' },
            payload: { mimeType: 'image/png', size: 4 },
        });

        expect(response.statusCode).toBe(500);
        expect(filesMock.putLocalFile).not.toHaveBeenCalled();
        expect(filesMock.s3client.presignedPostPolicy).not.toHaveBeenCalled();
    });
});
