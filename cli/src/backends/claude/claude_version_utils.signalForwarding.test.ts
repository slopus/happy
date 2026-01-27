import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachChildSignalForwarding } = require('../../../scripts/claude_version_utils.cjs') as any;

describe('claude_version_utils attachChildSignalForwarding', () => {
    it('forwards SIGTERM and SIGINT to child', () => {
        const handlers = new Map<string, (() => void)[]>();
        const proc = {
            platform: 'darwin',
            on: (event: string, handler: () => void) => {
                const list = handlers.get(event) ?? [];
                list.push(handler);
                handlers.set(event, list);
            },
        } as any;

        const child = {
            pid: 123,
            killed: false,
            kill: vi.fn(),
        } as any;

        attachChildSignalForwarding(child, proc);

        for (const handler of handlers.get('SIGTERM') ?? []) handler();
        for (const handler of handlers.get('SIGINT') ?? []) handler();

        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(child.kill).toHaveBeenCalledWith('SIGINT');
    });

    it('does not register SIGHUP on Windows', () => {
        const handlers = new Map<string, (() => void)[]>();
        const proc = {
            platform: 'win32',
            on: (event: string, handler: () => void) => {
                const list = handlers.get(event) ?? [];
                list.push(handler);
                handlers.set(event, list);
            },
        } as any;

        const child = { pid: 123, killed: false, kill: vi.fn() } as any;
        attachChildSignalForwarding(child, proc);

        expect(handlers.has('SIGHUP')).toBe(false);
    });
});
