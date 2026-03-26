import { describe, expect, it, vi } from "vitest";
import type { Backplane } from "@/modules/backplane/backplane";
import { MainDependencies, runMain } from "@/main";

function createDependencies() {
    const callOrder: string[] = [];
    const shutdownHandlers = new Map<string, () => Promise<void>>();

    const backplane: Backplane = {
        publish: vi.fn(async () => {}),
        subscribe: vi.fn(async () => {}),
        unsubscribe: vi.fn(async () => {}),
        destroy: vi.fn(async () => {
            callOrder.push('backplane.destroy');
        }),
        isHealthy: vi.fn(async () => true),
        getProcessId: vi.fn(() => 'process-1'),
    };

    const deps: MainDependencies = {
        db: {
            $connect: vi.fn(async () => {
                callOrder.push('db.$connect');
            }),
            $disconnect: vi.fn(async () => {
                callOrder.push('db.$disconnect');
            }),
        },
        createBackplane: vi.fn(async () => {
            callOrder.push('createBackplane');
            return backplane;
        }),
        eventRouter: {
            init: vi.fn(async (receivedBackplane: Backplane) => {
                callOrder.push('eventRouter.init');
                expect(receivedBackplane).toBe(backplane);
            }),
        },
        activityCache: {
            shutdown: vi.fn(() => {
                callOrder.push('activityCache.shutdown');
            }),
        },
        validateStartup: vi.fn((receivedBackplane: Backplane) => {
            callOrder.push('validateStartup');
            expect(receivedBackplane).toBe(backplane);
        }),
        initEncrypt: vi.fn(async () => {
            callOrder.push('initEncrypt');
        }),
        initGithub: vi.fn(async () => {
            callOrder.push('initGithub');
        }),
        loadFiles: vi.fn(async () => {
            callOrder.push('loadFiles');
        }),
        auth: {
            init: vi.fn(async () => {
                callOrder.push('auth.init');
            }),
        },
        startApi: vi.fn(async (receivedBackplane: Backplane) => {
            callOrder.push('startApi');
            expect(receivedBackplane).toBe(backplane);
        }),
        startMetricsServer: vi.fn(async () => {
            callOrder.push('startMetricsServer');
        }),
        startDatabaseMetricsUpdater: vi.fn(() => {
            callOrder.push('startDatabaseMetricsUpdater');
        }),
        startTimeout: vi.fn(() => {
            callOrder.push('startTimeout');
        }),
        onShutdown: vi.fn((name, callback) => {
            callOrder.push(`onShutdown:${name}`);
            shutdownHandlers.set(name, callback);
            return () => shutdownHandlers.delete(name);
        }),
        awaitShutdown: vi.fn(async () => {
            callOrder.push('awaitShutdown');
        }),
        log: vi.fn((message: string) => {
            callOrder.push(`log:${message}`);
        }),
    };

    return { deps, backplane, callOrder, shutdownHandlers };
}

describe('runMain', () => {
    it('creates and initializes the backplane before auth init and wires shutdown ordering', async () => {
        const { deps, callOrder } = createDependencies();

        await runMain(deps);

        expect(callOrder).toEqual([
            'db.$connect',
            'createBackplane',
            'eventRouter.init',
            'onShutdown:db',
            'onShutdown:backplane',
            'onShutdown:activity-cache',
            'validateStartup',
            'initEncrypt',
            'initGithub',
            'loadFiles',
            'auth.init',
            'startApi',
            'startMetricsServer',
            'startDatabaseMetricsUpdater',
            'startTimeout',
            'log:Ready',
            'awaitShutdown',
            'log:Shutting down...',
        ]);
    });

    it('registers a backplane shutdown handler that destroys the created backplane', async () => {
        const { deps, backplane, shutdownHandlers } = createDependencies();

        await runMain(deps);
        const shutdownBackplane = shutdownHandlers.get('backplane');

        expect(shutdownBackplane).toBeDefined();
        await shutdownBackplane!();

        expect(backplane.destroy).toHaveBeenCalledTimes(1);
    });
});
