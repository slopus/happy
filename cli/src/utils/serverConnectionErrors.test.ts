/**
 * Unit tests for serverConnectionErrors utility.
 *
 * ## Test Coverage Strategy
 * These tests exercise the real code paths with minimal mocking:
 * - Only axios.isAxiosError is mocked (needed for error type detection)
 * - Health check is injected for deterministic behavior
 * - Real exponentialBackoffDelay is used (tests account for timing)
 *
 * ## Requirements Verified
 * - REQ-1: Continue working when server unreachable (via graceful callback pattern)
 * - REQ-3: Exponential backoff (via retry tests)
 * - REQ-7: User notification (via onNotify callback verification)
 * - REQ-8: DRY implementation (single utility, verified by type system)
 * - REQ-9: Backend transparency (via generic TSession tests)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startOfflineReconnection, printOfflineWarning, connectionState, isNetworkError, NETWORK_ERROR_CODES } from './serverConnectionErrors';

// Mock axios - only isAxiosError needed for error type detection
vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
        isAxiosError: (e: unknown) => {
            return e !== null && typeof e === 'object' && 'isAxiosError' in e && (e as any).isAxiosError === true;
        }
    },
    isAxiosError: (e: unknown) => {
        return e !== null && typeof e === 'object' && 'isAxiosError' in e && (e as any).isAxiosError === true;
    }
}));

// Mock logger to prevent console noise in tests
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

// ============================================================================
// Test Helpers (DRY)
// ============================================================================

interface TestHandleConfig<T = { id: string }> {
    healthCheck?: () => Promise<void>;
    onReconnected?: () => Promise<T>;
    onNotify?: (msg: string) => void;
    onCleanup?: () => void;
    initialDelayMs?: number;
}

/**
 * Creates a test reconnection handle with sensible defaults.
 * Reduces boilerplate in individual tests.
 */
function createTestHandle<T = { id: string }>(config: TestHandleConfig<T> = {}) {
    const onReconnected = config.onReconnected ?? vi.fn().mockResolvedValue({ id: 'test-session' });
    const onNotify = config.onNotify ?? vi.fn();
    const onCleanup = config.onCleanup ?? vi.fn();

    const handle = startOfflineReconnection<T>({
        serverUrl: 'http://test-server',
        onReconnected: onReconnected as () => Promise<T>,
        onNotify,
        onCleanup,
        healthCheck: config.healthCheck ?? (async () => { /* success */ }),
        initialDelayMs: config.initialDelayMs ?? 1
    });

    return { handle, onReconnected, onNotify, onCleanup };
}

/**
 * Waits for reconnection to succeed, with timeout protection.
 * Polls isReconnected() to avoid flaky timing issues.
 */
async function waitForReconnection(
    handle: ReturnType<typeof startOfflineReconnection>,
    timeoutMs: number = 15000
): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        if (handle.isReconnected()) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

/**
 * Creates an axios-style error for testing error handling paths.
 */
function createAxiosError(status: number): Error & { response: { status: number }, isAxiosError: true } {
    const error = new Error(`HTTP ${status}`) as any;
    error.response = { status };
    error.isAxiosError = true;
    return error;
}

// ============================================================================
// Core Functionality Tests
// ============================================================================

describe('startOfflineReconnection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('successful reconnection', () => {
        it('should call onReconnected when health check succeeds', async () => {
            const { handle, onReconnected, onNotify } = createTestHandle();

            await waitForReconnection(handle);

            expect(onReconnected).toHaveBeenCalledOnce();
            expect(onNotify).toHaveBeenCalledWith('✅ Reconnected! Session syncing in background.');
            expect(handle.isReconnected()).toBe(true);

            handle.cancel();
        });

        it('should return session via getSession() after reconnection', async () => {
            const mockSession = { id: 'session-123', metadata: { path: '/test' } };
            const { handle } = createTestHandle({
                onReconnected: vi.fn().mockResolvedValue(mockSession)
            });

            expect(handle.getSession()).toBeNull(); // Before reconnection

            await waitForReconnection(handle);

            expect(handle.getSession()).toEqual(mockSession);
            expect(handle.getSession()?.id).toBe('session-123');

            handle.cancel();
        });

        it('should only reconnect once (idempotent)', async () => {
            const { handle, onReconnected } = createTestHandle();

            await waitForReconnection(handle);
            await new Promise(resolve => setTimeout(resolve, 200)); // Extra wait

            expect(onReconnected).toHaveBeenCalledTimes(1);

            handle.cancel();
        });
    });

    describe('retry behavior', () => {
        // NOTE: Retries are UNLIMITED. The "10" in exponentialBackoffDelay(failureCount, 5000, 60000, 10)
        // is the DELAY cap (delay stops growing at ~60s), NOT a retry limit.
        // Servers can be down for hours; sessions can stay open for weeks.

        it('should retry when health check fails then succeeds', async () => {
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                if (attemptCount < 2) throw new Error('ECONNREFUSED');
            };

            const { handle, onReconnected } = createTestHandle({ healthCheck });

            const success = await waitForReconnection(handle);

            expect(success).toBe(true);
            expect(attemptCount).toBeGreaterThanOrEqual(2);
            expect(onReconnected).toHaveBeenCalledOnce();

            handle.cancel();
        }, 20000);

        it('should retry when onReconnected throws', async () => {
            let callCount = 0;
            const onReconnected = vi.fn().mockImplementation(async () => {
                callCount++;
                if (callCount === 1) throw new Error('Session creation failed');
                return { id: 'session' };
            });

            const { handle } = createTestHandle({ onReconnected });

            const success = await waitForReconnection(handle);

            expect(success).toBe(true);
            expect(onReconnected).toHaveBeenCalledTimes(2);

            handle.cancel();
        }, 20000);

        it('should increment failure count on each retry', async () => {
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                if (attemptCount < 3) throw new Error('Network error');
            };

            const { handle } = createTestHandle({ healthCheck });

            try {
                // With jittered backoff, this can be non-deterministic. Use a deterministic RNG here so the test is stable.
                await waitForReconnection(handle, 25000);
                expect(attemptCount).toBe(3);
            } finally {
                handle.cancel();
                randomSpy.mockRestore();
            }
        }, 30000);
    });

    describe('cancellation', () => {
        it('should stop attempts when cancelled', async () => {
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                throw new Error('Always fail');
            };

            const { handle, onCleanup } = createTestHandle({ healthCheck });

            await new Promise(resolve => setTimeout(resolve, 50));
            const countBeforeCancel = attemptCount;

            handle.cancel();
            expect(onCleanup).toHaveBeenCalledOnce();

            await new Promise(resolve => setTimeout(resolve, 200));
            expect(attemptCount).toBe(countBeforeCancel);
        });

        it('should prevent reconnection if cancelled before first attempt', async () => {
            const { handle, onReconnected, onCleanup } = createTestHandle({
                initialDelayMs: 500 // Long delay to allow cancel before attempt
            });

            handle.cancel();
            expect(onCleanup).toHaveBeenCalledOnce();

            await new Promise(resolve => setTimeout(resolve, 600));

            expect(onReconnected).not.toHaveBeenCalled();
            expect(handle.isReconnected()).toBe(false);
        });

        it('should be safe to call cancel() multiple times', async () => {
            const onCleanup = vi.fn();
            const { handle } = createTestHandle({ onCleanup });

            handle.cancel();
            handle.cancel();
            handle.cancel();

            // onCleanup should still only be called once per cancel() call
            // (cancel sets cancelled=true, preventing further action)
            expect(onCleanup).toHaveBeenCalledTimes(3);
        });
    });

    describe('error handling', () => {
        it('should stop retrying on 401 authentication error', async () => {
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                throw createAxiosError(401);
            };

            const { handle, onNotify, onReconnected } = createTestHandle({ healthCheck });

            await new Promise(resolve => setTimeout(resolve, 100));

            expect(attemptCount).toBe(1);
            expect(onNotify).toHaveBeenCalledWith(
                '❌ Authentication failed. Please re-authenticate with `happy auth`.'
            );
            expect(onReconnected).not.toHaveBeenCalled();

            await new Promise(resolve => setTimeout(resolve, 200));
            expect(attemptCount).toBe(1); // No retry after auth failure

            handle.cancel();
        });

        it('should retry on 500 server error', async () => {
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                if (attemptCount < 2) throw createAxiosError(500);
            };

            const { handle } = createTestHandle({ healthCheck });

            await waitForReconnection(handle);

            expect(attemptCount).toBeGreaterThanOrEqual(2);
            expect(handle.isReconnected()).toBe(true);

            handle.cancel();
        }, 20000);

        it('should retry on 503 service unavailable', async () => {
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                if (attemptCount < 2) throw createAxiosError(503);
            };

            const { handle } = createTestHandle({ healthCheck });

            await waitForReconnection(handle);

            expect(attemptCount).toBeGreaterThanOrEqual(2);

            handle.cancel();
        }, 20000);

        it('should retry on non-axios network errors', async () => {
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                if (attemptCount < 2) {
                    const error = new Error('ECONNREFUSED');
                    (error as any).code = 'ECONNREFUSED';
                    throw error;
                }
            };

            const { handle } = createTestHandle({ healthCheck });

            await waitForReconnection(handle);

            expect(attemptCount).toBeGreaterThanOrEqual(2);

            handle.cancel();
        }, 20000);

        it('should retry on ETIMEDOUT errors', async () => {
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                if (attemptCount < 2) {
                    const error = new Error('ETIMEDOUT');
                    (error as any).code = 'ETIMEDOUT';
                    throw error;
                }
            };

            const { handle } = createTestHandle({ healthCheck });

            await waitForReconnection(handle);

            expect(attemptCount).toBeGreaterThanOrEqual(2);

            handle.cancel();
        }, 20000);

        it('should NOT stop retrying on 403 forbidden (not auth failure)', async () => {
            let attemptCount = 0;
            const healthCheck = async () => {
                attemptCount++;
                if (attemptCount < 2) throw createAxiosError(403);
            };

            const { handle, onNotify } = createTestHandle({ healthCheck });

            await waitForReconnection(handle);

            expect(attemptCount).toBeGreaterThanOrEqual(2);
            // Should NOT show auth failure message for 403
            expect(onNotify).not.toHaveBeenCalledWith(
                expect.stringContaining('Authentication failed')
            );
            expect(onNotify).toHaveBeenCalledWith('✅ Reconnected! Session syncing in background.');

            handle.cancel();
        }, 20000);
    });

    describe('edge cases', () => {
        it('should handle race condition: cancel during async health check', async () => {
            let healthCheckResolve: () => void;
            const healthCheckPromise = new Promise<void>(resolve => {
                healthCheckResolve = resolve;
            });

            const { handle, onReconnected } = createTestHandle({
                healthCheck: async () => {
                    await healthCheckPromise;
                }
            });

            // Wait for health check to start
            await new Promise(resolve => setTimeout(resolve, 50));

            // Cancel while health check is in progress
            handle.cancel();

            // Now let health check complete
            healthCheckResolve!();

            await new Promise(resolve => setTimeout(resolve, 50));

            // onReconnected should NOT be called because cancelled flag is set
            expect(onReconnected).not.toHaveBeenCalled();
            expect(handle.isReconnected()).toBe(false);
        });

        it('should handle race condition: cancel during async onReconnected', async () => {
            let onReconnectedResolve: () => void;
            const onReconnectedPromise = new Promise<{ id: string }>(resolve => {
                onReconnectedResolve = () => resolve({ id: 'session' });
            });

            const onReconnected = vi.fn().mockImplementation(async () => {
                return onReconnectedPromise;
            });

            const { handle, onNotify } = createTestHandle({ onReconnected });

            // Wait for onReconnected to start
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(onReconnected).toHaveBeenCalled();

            // Cancel while onReconnected is in progress
            handle.cancel();

            // Now let onReconnected complete
            onReconnectedResolve!();

            await new Promise(resolve => setTimeout(resolve, 50));

            // Session should still be set (async operation completed)
            // but no further actions should occur
            expect(handle.getSession()).toEqual({ id: 'session' });
        });

        it('should handle empty/undefined session from onReconnected', async () => {
            const { handle } = createTestHandle({
                onReconnected: vi.fn().mockResolvedValue(undefined)
            });

            await waitForReconnection(handle);

            expect(handle.isReconnected()).toBe(true);
            expect(handle.getSession()).toBeUndefined();

            handle.cancel();
        });

        it('should handle null session from onReconnected', async () => {
            const { handle } = createTestHandle({
                onReconnected: vi.fn().mockResolvedValue(null)
            });

            await waitForReconnection(handle);

            expect(handle.isReconnected()).toBe(true);
            expect(handle.getSession()).toBeNull();

            handle.cancel();
        });

        it('should support generic session types (type safety)', async () => {
            interface CustomSession {
                sessionId: string;
                metadata: {
                    path: string;
                    host: string;
                };
                capabilities: string[];
            }

            const customSession: CustomSession = {
                sessionId: 'custom-123',
                metadata: { path: '/workspace', host: 'localhost' },
                capabilities: ['read', 'write', 'execute']
            };

            const { handle } = createTestHandle<CustomSession>({
                onReconnected: vi.fn().mockResolvedValue(customSession)
            });

            await waitForReconnection(handle);

            const session = handle.getSession();
            expect(session?.sessionId).toBe('custom-123');
            expect(session?.metadata.path).toBe('/workspace');
            expect(session?.capabilities).toContain('write');

            handle.cancel();
        });

        it('should work without optional onCleanup callback', async () => {
            const handle = startOfflineReconnection({
                serverUrl: 'http://test',
                onReconnected: async () => ({ id: 'session' }),
                onNotify: vi.fn(),
                healthCheck: async () => {},
                initialDelayMs: 1
                // onCleanup intentionally omitted
            });

            await waitForReconnection(handle);

            // Should not throw when cancelling without onCleanup
            expect(() => handle.cancel()).not.toThrow();
        });
    });
});

// ============================================================================
// printOfflineWarning Tests
// ============================================================================

describe('printOfflineWarning', () => {
    beforeEach(() => {
        connectionState.reset(); // Reset singleton state between tests
    });

    it('should print offline warning with unified format', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        printOfflineWarning();

        // New unified format via connectionState.fail()
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('⚠️  Happy server unreachable, offline mode with auto-reconnect enabled')
        );
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('Server connection failed')
        );

        consoleSpy.mockRestore();
    });

    it('should deduplicate repeated calls', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        printOfflineWarning('Claude');
        const callCountAfterFirst = consoleSpy.mock.calls.length;

        printOfflineWarning('Claude'); // Second call should be deduplicated
        const callCountAfterSecond = consoleSpy.mock.calls.length;

        // Should not print again (same call count)
        expect(callCountAfterSecond).toBe(callCountAfterFirst);

        consoleSpy.mockRestore();
    });
});

// ============================================================================
// isNetworkError Tests
// ============================================================================

describe('isNetworkError', () => {
    it('should return true for all NETWORK_ERROR_CODES', () => {
        // All codes in NETWORK_ERROR_CODES should return true
        expect(isNetworkError('ECONNREFUSED')).toBe(true);
        expect(isNetworkError('ENOTFOUND')).toBe(true);
        expect(isNetworkError('ETIMEDOUT')).toBe(true);
        expect(isNetworkError('ECONNRESET')).toBe(true);
        expect(isNetworkError('EHOSTUNREACH')).toBe(true);
        expect(isNetworkError('ENETUNREACH')).toBe(true);
    });

    it('should return false for non-network error codes', () => {
        expect(isNetworkError('UNAUTHORIZED')).toBe(false);
        expect(isNetworkError('EACCES')).toBe(false);
        expect(isNetworkError('ENOENT')).toBe(false);
        expect(isNetworkError('UNKNOWN')).toBe(false);
    });

    it('should return false for undefined', () => {
        expect(isNetworkError(undefined)).toBe(false);
    });

    it('should return false for empty string', () => {
        expect(isNetworkError('')).toBe(false);
    });

    it('should have exactly 6 network error codes', () => {
        expect(NETWORK_ERROR_CODES).toHaveLength(6);
        expect(NETWORK_ERROR_CODES).toContain('ECONNREFUSED');
        expect(NETWORK_ERROR_CODES).toContain('ENOTFOUND');
        expect(NETWORK_ERROR_CODES).toContain('ETIMEDOUT');
        expect(NETWORK_ERROR_CODES).toContain('ECONNRESET');
        expect(NETWORK_ERROR_CODES).toContain('EHOSTUNREACH');
        expect(NETWORK_ERROR_CODES).toContain('ENETUNREACH');
    });
});
