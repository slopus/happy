import { describe, it, expect } from 'vitest';

describe('Runtime Integration Tests', () => {
    it('runtime detection is consistent across imports', async () => {
        const { getRuntime } = await import('../runtime.js');
        const runtime1 = getRuntime();

        // Re-import to test caching
        const { getRuntime: getRuntime2 } = await import('../runtime.js');
        const runtime2 = getRuntime2();

        expect(runtime1).toBe(runtime2);
        expect(['node', 'bun', 'deno', 'unknown']).toContain(runtime1);
    });

    it('runtime detection works in actual execution environment', async () => {
        const { getRuntime, isNode, isBun, isDeno } = await import('../runtime.js');

        const runtime = getRuntime();

        if (process.versions.node && !process.versions.bun && !process.versions.deno) {
            expect(runtime).toBe('node');
            expect(isNode()).toBe(true);
            expect(isBun()).toBe(false);
            expect(isDeno()).toBe(false);
        } else if (process.versions.bun) {
            expect(runtime).toBe('bun');
            expect(isNode()).toBe(false);
            expect(isBun()).toBe(true);
            expect(isDeno()).toBe(false);
        } else if (process.versions.deno) {
            expect(runtime).toBe('deno');
            expect(isNode()).toBe(false);
            expect(isBun()).toBe(false);
            expect(isDeno()).toBe(true);
        }
    });

    it('runtime utilities can be imported correctly', async () => {
        const runtimeModule = await import('../runtime.js');

        // Check that all expected exports are available
        expect(typeof runtimeModule.getRuntime).toBe('function');
        expect(typeof runtimeModule.isBun).toBe('function');
        expect(typeof runtimeModule.isNode).toBe('function');
        expect(typeof runtimeModule.isDeno).toBe('function');
        expect(typeof runtimeModule.getRuntime()).toBe('string');
    });

    it('provides correct runtime type', async () => {
        const { getRuntime } = await import('../runtime.js');
        const runtime = getRuntime();
        expect(['node', 'bun', 'deno', 'unknown']).toContain(runtime);
    });
});