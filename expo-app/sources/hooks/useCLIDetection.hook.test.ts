import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useMachineDetectCliCacheMock = vi.fn();

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

vi.mock('@/hooks/useMachineDetectCliCache', () => {
    return {
        useMachineDetectCliCache: (...args: any[]) => useMachineDetectCliCacheMock(...args),
    };
});

vi.mock('@/sync/ops', () => {
    return {
        machineBash: vi.fn(async () => {
            return { success: false, exitCode: 1, stdout: '', stderr: '' };
        }),
    };
});

describe('useCLIDetection (hook)', () => {
    it('includes tmux availability from detect-cli response when present', async () => {
        useMachineDetectCliCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                response: {
                    path: null,
                    clis: {
                        claude: { available: true },
                        codex: { available: true },
                        gemini: { available: true },
                    },
                    tmux: { available: true },
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
        useMachineDetectCliCacheMock.mockReturnValue({
            state: {
                status: 'loaded',
                response: {
                    path: null,
                    clis: {
                        claude: { available: true },
                        codex: { available: true },
                        gemini: { available: true },
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
});
