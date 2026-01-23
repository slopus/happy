import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useMachineCapabilitiesCacheMock = vi.fn();

vi.mock('@/sync/storage', () => {
    return {
        useMachine: vi.fn(() => ({ id: 'm1', metadata: {} })),
    };
});

vi.mock('@/utils/machineUtils', () => {
    return {
        isMachineOnline: vi.fn(() => true),
    };
});

vi.mock('@/hooks/useMachineCapabilitiesCache', () => {
    return {
        useMachineCapabilitiesCache: (...args: any[]) => useMachineCapabilitiesCacheMock(...args),
    };
});

describe('useCLIDetection (hook)', () => {
    it('includes tmux availability from capabilities results when present', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.claude': { ok: true, checkedAt: 1, data: { available: true } },
                            'cli.codex': { ok: true, checkedAt: 1, data: { available: true } },
                            'cli.gemini': { ok: true, checkedAt: 1, data: { available: true } },
                            'tool.tmux': { ok: true, checkedAt: 1, data: { available: true } },
                        },
                    },
                },
            },
            refresh: vi.fn(),
        });

        const { useCLIDetection } = await import('./useCLIDetection');

        let latest: any = null;
        function Test() {
            latest = useCLIDetection('m1', { autoDetect: false });
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latest?.tmux).toBe(true);
    });

    it('treats missing tmux field as unknown (null) for older daemons', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                snapshot: {
                    response: {
                        protocolVersion: 1,
                        results: {
                            'cli.claude': { ok: true, checkedAt: 1, data: { available: true } },
                            'cli.codex': { ok: true, checkedAt: 1, data: { available: true } },
                            'cli.gemini': { ok: true, checkedAt: 1, data: { available: true } },
                        },
                    },
                },
            },
            refresh: vi.fn(),
        });

        const { useCLIDetection } = await import('./useCLIDetection');

        let latest: any = null;
        function Test() {
            latest = useCLIDetection('m1', { autoDetect: false });
            return React.createElement('View');
        }

        act(() => {
            renderer.create(React.createElement(Test));
        });

        expect(latest?.tmux).toBe(null);
    });

    it('keeps timestamp stable when results have no checkedAt values', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1000);

            useMachineCapabilitiesCacheMock.mockReturnValueOnce({
                state: {
                    status: 'loaded',
                    snapshot: {
                        response: {
                            protocolVersion: 1,
                            results: {},
                        },
                    },
                },
                refresh: vi.fn(),
            });

            const { useCLIDetection } = await import('./useCLIDetection');

            let latest: any = null;
            function Test() {
                latest = useCLIDetection('m1', { autoDetect: false });
                return React.createElement('View');
            }

            let root: any = null;
            act(() => {
                root = renderer.create(React.createElement(Test));
            });
            expect(latest?.timestamp).toBe(1000);

            vi.setSystemTime(2000);

            useMachineCapabilitiesCacheMock.mockReturnValueOnce({
                state: {
                    status: 'loaded',
                    snapshot: {
                        response: {
                            protocolVersion: 1,
                            results: {},
                        },
                    },
                },
                refresh: vi.fn(),
            });

            act(() => {
                root.update(React.createElement(Test));
            });

            expect(latest?.timestamp).toBe(1000);
        } finally {
            vi.useRealTimers();
        }
    });
});
