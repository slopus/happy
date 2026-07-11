import { describe, it, expect, vi } from 'vitest';
import { registerChangeTitleHandler } from './registerChangeTitleHandler';
import type { RpcHandlerManager } from './RpcHandlerManager';

function setup() {
    const handlers = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
        registerHandler: vi.fn((method: string, handler: (params: any) => Promise<any>) => {
            handlers.set(method, handler);
        }),
    } as unknown as RpcHandlerManager;
    const changeTitle = vi.fn();
    registerChangeTitleHandler(rpcHandlerManager, changeTitle);
    const handler = handlers.get('changeTitle');
    if (!handler) {
        throw new Error('changeTitle handler not registered');
    }
    return { handler, changeTitle };
}

describe('registerChangeTitleHandler', () => {
    it('registers a changeTitle handler', () => {
        const { handler } = setup();
        expect(handler).toBeTypeOf('function');
    });

    it('trims the title and forwards it to changeTitle', async () => {
        const { handler, changeTitle } = setup();
        const result = await handler({ title: '  New name  ' });
        expect(changeTitle).toHaveBeenCalledWith('New name');
        expect(result).toEqual({ success: true });
    });

    it('rejects an empty or whitespace-only title without calling changeTitle', async () => {
        const { handler, changeTitle } = setup();
        for (const title of ['', '   ']) {
            const result = await handler({ title });
            expect(result.success).toBe(false);
            expect(result.error).toBeTruthy();
        }
        expect(changeTitle).not.toHaveBeenCalled();
    });

    it('rejects a missing or non-string title', async () => {
        const { handler, changeTitle } = setup();
        expect((await handler({})).success).toBe(false);
        expect((await handler({ title: 42 })).success).toBe(false);
        expect(changeTitle).not.toHaveBeenCalled();
    });
});
