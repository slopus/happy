import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const {
    state,
    dbMock,
    filesMock,
    emitUpdate,
    resetState,
} = vi.hoisted(() => {
    type Project = {
        id: string;
        accountId: string;
        externalId: string;
        metadata: string;
        metadataVersion: number;
        dataEncryptionKey: Uint8Array | null;
        avatarRef: string | null;
        avatarPreview: string | null;
        avatarVersion: number;
        seq: number;
        createdAt: Date;
        updatedAt: Date;
    };

    const state = {
        projects: [] as Project[],
        sessions: [] as Array<{ id: string; accountId: string; projectId: string | null }>,
        uploads: new Map<string, Buffer>(),
        s3Objects: new Set<string>(),
        useLocalStorage: true,
        nextId: 1,
    };

    const resetState = () => {
        state.projects = [];
        state.sessions = [];
        state.uploads = new Map();
        state.s3Objects = new Set();
        state.useLocalStorage = true;
        state.nextId = 1;
    };

    const matches = (project: Project, where: any) => {
        if (typeof where?.id === 'string' && project.id !== where.id) return false;
        if (Array.isArray(where?.id?.in) && !where.id.in.includes(project.id)) return false;
        if (where?.accountId && project.accountId !== where.accountId) return false;
        if (where?.externalId && project.externalId !== where.externalId) return false;
        return true;
    };

    const clone = (project: Project): Project => ({ ...project });
    const projectFindFirst = vi.fn(async (args: any) => {
        const project = state.projects.find((candidate) => matches(candidate, args?.where));
        return project ? clone(project) : null;
    });
    const projectFindMany = vi.fn(async (args: any) => state.projects
        .filter((project) => matches(project, args?.where))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map(clone));
    const projectCreate = vi.fn(async (args: any) => {
        const now = new Date();
        const project: Project = {
            id: `p${state.nextId++}`,
            accountId: args.data.accountId,
            externalId: args.data.externalId,
            metadata: args.data.metadata,
            metadataVersion: args.data.metadataVersion ?? 1,
            dataEncryptionKey: args.data.dataEncryptionKey ?? null,
            avatarRef: null,
            avatarPreview: null,
            avatarVersion: 0,
            seq: 0,
            createdAt: now,
            updatedAt: now,
        };
        state.projects.push(project);
        return clone(project);
    });
    const projectUpdate = vi.fn(async (args: any) => {
        const project = state.projects.find((candidate) => candidate.id === args.where.id)!;
        const data = args.data;
        if (data.metadata !== undefined) project.metadata = data.metadata;
        if (data.metadataVersion?.increment) project.metadataVersion += data.metadataVersion.increment;
        if (data.dataEncryptionKey !== undefined) project.dataEncryptionKey = data.dataEncryptionKey;
        if (data.avatarRef !== undefined) project.avatarRef = data.avatarRef;
        if (data.avatarPreview !== undefined) project.avatarPreview = data.avatarPreview;
        if (data.avatarVersion?.increment) project.avatarVersion += data.avatarVersion.increment;
        if (data.seq?.increment) project.seq += data.seq.increment;
        project.updatedAt = new Date(project.updatedAt.getTime() + 1);
        return clone(project);
    });
    const projectDelete = vi.fn(async (args: any) => {
        const index = state.projects.findIndex((candidate) => candidate.id === args.where.id);
        if (index >= 0) state.projects.splice(index, 1);
    });
    const sessionFindMany = vi.fn(async (args: any) => state.sessions
        .filter((session) => session.projectId === args?.where?.projectId)
        .map((session) => ({ id: session.id })));
    const sessionUpdateMany = vi.fn(async (args: any) => {
        for (const session of state.sessions) {
            if (session.projectId === args.where.projectId) session.projectId = args.data.projectId;
        }
        return { count: state.sessions.length };
    });

    const dbMock = {
        project: { findFirst: projectFindFirst, findMany: projectFindMany, create: projectCreate, update: projectUpdate, delete: projectDelete },
        session: { findMany: sessionFindMany, updateMany: sessionUpdateMany },
    };
    const emitUpdate = vi.fn();
    const filesMock = {
        s3client: {
            newPostPolicy: () => ({
                setBucket: vi.fn(),
                setKey: vi.fn(),
                setExpires: vi.fn(),
                setContentLengthRange: vi.fn(),
            }),
            presignedPostPolicy: vi.fn(async () => ({ postURL: 'https://s3.test/upload', formData: { policy: 'test' } })),
            presignedGetObject: vi.fn(async () => 'https://s3.test/download'),
            statObject: vi.fn(async (_bucket: string, ref: string) => {
                if (!state.s3Objects.has(ref)) throw new Error('missing');
                return { size: 3 };
            }),
        },
        s3bucket: 'test-bucket',
        isLocalStorage: vi.fn(() => state.useLocalStorage),
        getLocalFilesDir: vi.fn(() => '/tmp/project-test-files'),
        putLocalFile: vi.fn(async (filePath: string, data: Buffer) => state.uploads.set(filePath, data)),
        deleteProjectAvatars: vi.fn(async () => undefined),
    };

    return { state, dbMock, filesMock, emitUpdate, resetState };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/files', () => filesMock);
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        existsSync: vi.fn((filePath: string) => {
            const ref = filePath.replace(/^\/tmp\/project-test-files\//, '');
            return state.uploads.has(ref);
        }),
        readFileSync: vi.fn((filePath: string) => {
            const ref = filePath.replace(/^\/tmp\/project-test-files\//, '');
            return state.uploads.get(ref) ?? Buffer.alloc(0);
        }),
    };
});
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn(async () => 1) }));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate },
    buildNewProjectUpdate: vi.fn((project: any) => ({ body: { t: 'new-project', projectId: project.id } })),
    buildUpdateProjectUpdate: vi.fn((project: any) => ({ body: { t: 'update-project', projectId: project.id } })),
    buildDeleteProjectUpdate: vi.fn((projectId: string) => ({ body: { t: 'delete-project', projectId } })),
    buildUpdateSessionUpdate: vi.fn((sessionId: string) => ({ body: { t: 'update-session', id: sessionId } })),
}));
vi.mock('@/storage/inTx', () => ({
    inTx: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(dbMock)),
    afterTx: vi.fn((_tx: any, callback: () => void) => { void callback(); }),
}));

import { projectRoutes } from './projectRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    projectRoutes(typed);
    await typed.ready();
    return typed;
}

describe('projectRoutes', () => {
    let app: Fastify;

    beforeEach(() => resetState());
    afterEach(async () => { if (app) await app.close(); });

    it('creates and idempotently loads an account-owned encrypted project', async () => {
        app = await createApp();
        const first = await app.inject({
            method: 'POST',
            url: '/v1/projects',
            headers: { 'x-user-id': 'u1' },
            payload: { externalId: 'checkout-a', metadata: 'encrypted-v1', dataEncryptionKey: 'AQI=' },
        });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({ externalId: 'checkout-a', metadata: 'encrypted-v1', metadataVersion: 1, dataEncryptionKey: 'AQI=', avatar: null });

        const retry = await app.inject({
            method: 'POST',
            url: '/v1/projects',
            headers: { 'x-user-id': 'u1' },
            payload: { externalId: 'checkout-a', metadata: 'must-not-overwrite' },
        });
        expect(retry.statusCode).toBe(200);
        expect(retry.json().metadata).toBe('encrypted-v1');

        const legacy = await app.inject({
            method: 'POST',
            url: '/v1/projects',
            headers: { 'x-user-id': 'u1' },
            payload: { tag: 'checkout-a', metadata: 'must-not-overwrite' },
        });
        expect(legacy.statusCode).toBe(400);
    });

    it('does not expose another account project and uses optimistic metadata versions', async () => {
        app = await createApp();
        const one = await app.inject({ method: 'POST', url: '/v1/projects', headers: { 'x-user-id': 'u1' }, payload: { externalId: 'a', metadata: 'one' } });
        const two = await app.inject({ method: 'POST', url: '/v1/projects', headers: { 'x-user-id': 'u2' }, payload: { externalId: 'b', metadata: 'two' } });
        const three = await app.inject({ method: 'POST', url: '/v1/projects', headers: { 'x-user-id': 'u1' }, payload: { externalId: 'c', metadata: 'three' } });
        expect(one.statusCode).toBe(200);
        expect(two.statusCode).toBe(200);
        expect(three.statusCode).toBe(200);

        const list = await app.inject({
            method: 'GET',
            url: `/v1/projects?ids=${one.json().id},${two.json().id}`,
            headers: { 'x-user-id': 'u1' },
        });
        expect(list.json().projects).toHaveLength(1);
        expect(list.json().projects[0].id).toBe(one.json().id);
        const projectId = one.json().id;
        const legacyPatch = await app.inject({
            method: 'PATCH',
            url: `/v1/projects/${projectId}`,
            headers: { 'x-user-id': 'u1' },
            payload: { metadata: 'two', expectedVersion: 1 },
        });
        expect(legacyPatch.statusCode).toBe(400);
        const conflict = await app.inject({
            method: 'PATCH',
            url: `/v1/projects/${projectId}`,
            headers: { 'x-user-id': 'u1' },
            payload: { metadata: 'two', expectedMetadataVersion: 99 },
        });
        expect(conflict.statusCode).toBe(409);
        const update = await app.inject({
            method: 'PATCH',
            url: `/v1/projects/${projectId}`,
            headers: { 'x-user-id': 'u1' },
            payload: { metadata: 'two', expectedMetadataVersion: 1 },
        });
        expect(update.statusCode).toBe(200);
        expect(update.json()).toMatchObject({ metadata: 'two', metadataVersion: 2 });
    });

    it('uploads locally, requires explicit avatar activation, and downloads only the current ref', async () => {
        app = await createApp();
        const created = await app.inject({ method: 'POST', url: '/v1/projects', headers: { 'x-user-id': 'u1' }, payload: { externalId: 'a', metadata: 'one', dataEncryptionKey: 'AQI=' } });
        const projectId = created.json().id;
        const upload = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/avatar/request-upload`, headers: { 'x-user-id': 'u1' }, payload: { size: 3 } });
        expect(upload.statusCode).toBe(200);
        expect(upload.json().method).toBe('PUT');
        expect(upload.json().ref).toMatch(new RegExp(`^projects/${projectId}/avatar/.+\\.enc$`));

        const ref = upload.json().ref as string;
        const file = ref.slice(ref.lastIndexOf('/') + 1);
        const bytes = await app.inject({ method: 'PUT', url: `/v1/projects/${projectId}/avatar/${file}`, headers: { 'x-user-id': 'u1', 'content-type': 'application/octet-stream' }, payload: Buffer.from('abc') });
        expect(bytes.statusCode).toBe(200);
        expect(state.uploads.get(ref)).toEqual(Buffer.from('abc'));

        const missing = await app.inject({ method: 'PATCH', url: `/v1/projects/${projectId}/avatar`, headers: { 'x-user-id': 'u1' }, payload: { ref: `projects/${projectId}/avatar/00000000-0000-4000-8000-000000000000.enc`, preview: 'encrypted-preview' } });
        expect(missing.statusCode).toBe(404);
        const invalid = await app.inject({ method: 'PATCH', url: `/v1/projects/${projectId}/avatar`, headers: { 'x-user-id': 'u1' }, payload: { ref: 'projects/other/avatar/a.enc', preview: 'ciphertext' } });
        expect(invalid.statusCode).toBe(400);
        const active = await app.inject({ method: 'PATCH', url: `/v1/projects/${projectId}/avatar`, headers: { 'x-user-id': 'u1' }, payload: { ref, preview: 'encrypted-preview' } });
        expect(active.statusCode).toBe(200);
        expect(active.json().avatar).toMatchObject({ ref, preview: 'encrypted-preview', version: 1 });

        const keyPatch = await app.inject({ method: 'PATCH', url: `/v1/projects/${projectId}`, headers: { 'x-user-id': 'u1' }, payload: { dataEncryptionKey: 'AgM=' } });
        expect(keyPatch.statusCode).toBe(400);
        const metadataPatch = await app.inject({ method: 'PATCH', url: `/v1/projects/${projectId}`, headers: { 'x-user-id': 'u1' }, payload: { metadata: 'one-updated', expectedMetadataVersion: 1 } });
        expect(metadataPatch.statusCode).toBe(200);
        expect(metadataPatch.json().dataEncryptionKey).toBe(created.json().dataEncryptionKey);

        const historicalFile = '00000000-0000-4000-8000-000000000000.enc';
        state.uploads.set(`projects/${projectId}/avatar/${historicalFile}`, Buffer.from('old'));
        const historical = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/avatar/${historicalFile}`, headers: { 'x-user-id': 'u1' } });
        expect(historical.statusCode).toBe(404);
        const currentFile = await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/avatar/${file}`, headers: { 'x-user-id': 'u1' } });
        expect(currentFile.statusCode).toBe(200);

        const download = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/avatar/request-download`, headers: { 'x-user-id': 'u1' } });
        expect(download.statusCode).toBe(200);
        expect(download.json().ref).toBe(ref);
        expect(download.json().downloadUrl).toContain(`/v1/projects/${projectId}/avatar/${file}`);
    });

    it('uses a bounded S3 POST policy and presigned GET for activated avatars', async () => {
        state.useLocalStorage = false;
        app = await createApp();
        const created = await app.inject({ method: 'POST', url: '/v1/projects', headers: { 'x-user-id': 'u1' }, payload: { externalId: 's3', metadata: 'one' } });
        const projectId = created.json().id;
        const upload = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/avatar/request-upload`, headers: { 'x-user-id': 'u1' }, payload: { size: 1024 } });
        expect(upload.statusCode).toBe(200);
        expect(upload.json()).toMatchObject({ method: 'POST', uploadUrl: 'https://s3.test/upload' });
        state.s3Objects.add(upload.json().ref);
        const active = await app.inject({ method: 'PATCH', url: `/v1/projects/${projectId}/avatar`, headers: { 'x-user-id': 'u1' }, payload: { ref: upload.json().ref, preview: 'encrypted-preview' } });
        expect(active.statusCode).toBe(200);
        const download = await app.inject({ method: 'POST', url: `/v1/projects/${projectId}/avatar/request-download`, headers: { 'x-user-id': 'u1' } });
        expect(download.statusCode).toBe(200);
        expect(download.json().downloadUrl).toBe('https://s3.test/download');
    });

    it('unlinks sessions and cleans avatar storage on project deletion', async () => {
        app = await createApp();
        const created = await app.inject({ method: 'POST', url: '/v1/projects', headers: { 'x-user-id': 'u1' }, payload: { externalId: 'a', metadata: 'one' } });
        const projectId = created.json().id;
        state.sessions.push({ id: 's1', accountId: 'u1', projectId });
        const deleted = await app.inject({ method: 'DELETE', url: `/v1/projects/${projectId}`, headers: { 'x-user-id': 'u1' } });
        expect(deleted.statusCode).toBe(200);
        expect(state.sessions[0].projectId).toBeNull();
        expect(filesMock.deleteProjectAvatars).toHaveBeenCalledWith(projectId);
    });
});