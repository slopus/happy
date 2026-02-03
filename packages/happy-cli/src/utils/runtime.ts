/**
 * Runtime utilities - minimal, focused, testable
 * Single responsibility: detect current JavaScript runtime
 */

// Type safety with explicit union
export type Runtime = 'node' | 'bun' | 'deno' | 'unknown';

// Cache result after first detection (performance optimization)
let cachedRuntime: Runtime | null = null;

/**
 * Detect current runtime with fallback chain
 * Most reliable detection first, falling back to less reliable methods
 */
export function getRuntime(): Runtime {
    if (cachedRuntime) return cachedRuntime;

    // Method 1: Global runtime objects (most reliable)
    if (typeof (globalThis as any).Bun !== 'undefined') {
        cachedRuntime = 'bun';
        return cachedRuntime;
    }

    if (typeof (globalThis as any).Deno !== 'undefined') {
        cachedRuntime = 'deno';
        return cachedRuntime;
    }

    // Method 2: Process versions (fallback)
    if (process?.versions?.bun) {
        cachedRuntime = 'bun';
        return cachedRuntime;
    }

    if (process?.versions?.deno) {
        cachedRuntime = 'deno';
        return cachedRuntime;
    }

    if (process?.versions?.node) {
        cachedRuntime = 'node';
        return cachedRuntime;
    }

    cachedRuntime = 'unknown';
    return cachedRuntime;
}

// Convenience predicates - single responsibility each
export const isBun = (): boolean => getRuntime() === 'bun';
export const isNode = (): boolean => getRuntime() === 'node';
export const isDeno = (): boolean => getRuntime() === 'deno';