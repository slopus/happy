import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    dbConnect: vi.fn(),
    dbDisconnect: vi.fn(),
    initEncrypt: vi.fn(),
    initGithub: vi.fn(),
    loadFiles: vi.fn(),
    authInit: vi.fn(),
    startApi: vi.fn(),
    startCleanup: vi.fn(),
    startMetrics: vi.fn(),
    startTimeout: vi.fn(),
    onShutdown: vi.fn(),
}));

vi.mock('./storage/db', () => ({ db: { $connect: mocks.dbConnect, $disconnect: mocks.dbDisconnect } }));
vi.mock('./modules/encrypt', () => ({ initEncrypt: mocks.initEncrypt }));
vi.mock('./modules/github', () => ({ initGithub: mocks.initGithub }));
vi.mock('./storage/files', () => ({ loadFiles: mocks.loadFiles }));
vi.mock('./app/auth/auth', () => ({ auth: { init: mocks.authInit } }));
vi.mock('./app/presence/sessionCache', () => ({ activityCache: { shutdown: vi.fn() } }));
vi.mock('./app/api/api', () => ({ startApi: mocks.startApi }));
vi.mock('./app/monitoring/metrics2', () => ({ startDatabaseMetricsUpdater: mocks.startMetrics }));
vi.mock('./app/presence/timeout', () => ({ startTimeout: mocks.startTimeout }));
vi.mock('./app/sessionSharing/publicSessionShareCleanup', () => ({ startPublicSessionShareCleanup: mocks.startCleanup }));
vi.mock('./utils/shutdown', () => ({ onShutdown: mocks.onShutdown }));

import { startServer } from './index';

describe('startServer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.startApi.mockResolvedValue({ port: 3005, host: '127.0.0.1' });
    });

    it('starts durable public-share cleanup for the exported self-host server', async () => {
        await expect(startServer({
            pgliteDir: '/tmp/happy-server-test',
            masterSecret: 'test-secret',
            port: 3005,
            host: '127.0.0.1',
        })).resolves.toEqual({ port: 3005, host: '127.0.0.1' });

        expect(mocks.startCleanup).toHaveBeenCalledTimes(1);
        expect(mocks.startApi).toHaveBeenCalledBefore(mocks.startCleanup);
    });
});
