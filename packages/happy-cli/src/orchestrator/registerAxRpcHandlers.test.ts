import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAxRpcHandlers } from './registerAxRpcHandlers';
import { bootstrapWorkspace } from './state/bootstrap';
import { readState } from './state/io';
import { AxState } from './state/schema';

/**
 * Minimal stub of `RpcHandlerManager.registerHandler` — captures handlers in a
 * map so the test can invoke them directly without standing up an actual
 * socket. The production manager has more surface (error normalization, etc.)
 * but this is sufficient to verify the orchestration logic above the wire.
 */
type Handler = (req: unknown) => Promise<unknown>;
class StubManager {
    handlers = new Map<string, Handler>();
    registerHandler<TReq, TRes>(name: string, handler: (req: TReq) => Promise<TRes>) {
        this.handlers.set(name, handler as unknown as Handler);
    }
    async call<T>(name: string, req: unknown = undefined): Promise<T> {
        const h = this.handlers.get(name);
        if (!h) throw new Error(`No handler registered: ${name}`);
        return (await h(req)) as T;
    }
}

let workspace: string;
let manager: StubManager;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ax-rpc-'));
    manager = new StubManager();
    registerAxRpcHandlers(manager as never, workspace);
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('ax:bootstrap', () => {
    it('creates .ax/state.json at the requested step', async () => {
        const { state } = await manager.call<{ state: AxState }>('ax:bootstrap', { step: 'plan' });
        expect(state.step).toBe('plan');
        const onDisk = await readState(workspace);
        expect(onDisk).toEqual(state);
    });

    it('defaults to plan when step is omitted', async () => {
        const { state } = await manager.call<{ state: AxState }>('ax:bootstrap', {});
        expect(state.step).toBe('plan');
    });

    it('is idempotent — second call preserves existing state', async () => {
        await manager.call('ax:bootstrap', { step: 'plan' });
        const before = await readState(workspace);
        await manager.call('ax:bootstrap', { step: 'plan' });
        const after = await readState(workspace);
        expect(after).toEqual(before);
    });
});

describe('ax:get-state', () => {
    it('returns null when workspace has no state', async () => {
        const r = await manager.call<{ state: AxState | null }>('ax:get-state');
        expect(r.state).toBeNull();
    });

    it('returns the bootstrapped state', async () => {
        await bootstrapWorkspace(workspace, 'design');
        const r = await manager.call<{ state: AxState }>('ax:get-state');
        expect(r.state.step).toBe('design');
    });
});

describe('ax:transition', () => {
    it('moves step + appends history', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const r = await manager.call<{ state: AxState }>('ax:transition', { to: 'work' });
        expect(r.state.step).toBe('work');
        expect(r.state.history.at(-1)).toMatchObject({ from: 'plan', to: 'work' });
    });

    it('rejects unknown step', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        await expect(manager.call('ax:transition', { to: 'bogus' })).rejects.toThrow();
    });
});

describe('ax:permission', () => {
    it('always: persists permission and returns updated state', async () => {
        await bootstrapWorkspace(workspace, 'work');
        const r = await manager.call<{ state: AxState }>('ax:permission', {
            target: 'editPlanMd',
            decision: 'always',
        });
        expect(r.state.work.permissions.editPlanMd).toBe('always');
    });

    it('rejects invalid target', async () => {
        await bootstrapWorkspace(workspace, 'work');
        await expect(
            manager.call('ax:permission', { target: 'editOther', decision: 'always' }),
        ).rejects.toThrow(/Invalid permission target/);
    });

    it('rejects invalid decision', async () => {
        await bootstrapWorkspace(workspace, 'work');
        await expect(
            manager.call('ax:permission', { target: 'editPlanMd', decision: 'maybe' }),
        ).rejects.toThrow(/Invalid permission decision/);
    });
});
