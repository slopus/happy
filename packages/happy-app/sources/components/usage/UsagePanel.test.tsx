import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    filterCodexHeatmapMonthLabels,
    getCodexHeatmapCellMetrics,
    UsagePanel,
} from './UsagePanel';
import { zhHans } from '@/text/translations/zh-Hans';
import { appThemes } from '@/themePacks';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    calculateTotals: vi.fn(),
    credentials: { token: 'test' } as { token: string } | null,
    currentMachineId: null as string | null,
    currentCodexProfileId: null as string | null,
    extraSessions: {} as Record<string, { metadata: { machineId: string } }>,
    getUsageForPeriod: vi.fn(),
    language: 'en',
    machineRPC: vi.fn(),
    codexProfiles: [] as Array<{
        id: string;
        displayName: string;
        status: 'available' | 'needs-refresh' | 'invalid';
        credentialVersion: number;
        createdAt: string;
        updatedAt: string;
        lastValidatedAt: string | null;
        quota: {
            state: 'unknown' | 'current' | 'stale' | 'reset';
            remainingPercent: number | null;
            weeklyResetsAt: string | null;
            observedAt: string | null;
        };
    }>,
    machines: [] as Array<{
        active?: boolean;
        activeAt?: number;
        daemonState: unknown;
        id?: string;
    }>,
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        OS: 'web',
        select: (values: Record<string, unknown>) => values.web ?? values.default,
    },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    View: 'View',
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await vi.importActual<typeof import('@/themePacks')>('@/themePacks');
    const theme = appThemes.ginghamDark;
    return {
        StyleSheet: {
            create: (factory: unknown) => typeof factory === 'function'
                ? (factory as (value: typeof theme) => object)(theme)
                : factory,
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ credentials: mocks.credentials }),
}));
vi.mock('@/sync/storage', () => ({
    storage: (selector: (state: unknown) => unknown) => selector({
        currentViewingSessionId: mocks.currentMachineId ? 'current-session' : null,
        sessions: { ...mocks.extraSessions, ...(mocks.currentMachineId ? {
            'current-session': { metadata: { machineId: mocks.currentMachineId, codexAccountProfileId: mocks.currentCodexProfileId } },
        } : {}) },
    }),
    useAllMachines: () => mocks.machines,
}));
vi.mock('@/sync/apiUsage', () => ({
    getUsageForPeriod: mocks.getUsageForPeriod,
    calculateTotals: mocks.calculateTotals,
}));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { machineRPC: mocks.machineRPC },
}));
vi.mock('@/hooks/useCodexAccounts', () => ({
    useCodexAccounts: () => ({
        profiles: mocks.codexProfiles,
        bindings: [],
        migration: 'none',
        loading: false,
        busy: false,
        error: null,
    }),
}));
vi.mock('./UsageChart', () => ({ UsageChart: 'UsageChart' }));
vi.mock('./UsageBar', () => ({ UsageBar: 'UsageBar' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/utils/errors', () => ({ HappyError: class HappyError extends Error {} }));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => mocks.language,
    t: (key: string, values?: Record<string, unknown>) => {
        if (key === 'machine.codexUsageHeatmapDay' && mocks.language === 'zh-Hans' && values) {
            return `${values.date}：${values.tokens} token · ${values.sessions} 个会话`;
        }
        return values ? `${key}:${JSON.stringify(values)}` : key;
    },
}));

const emptyTotals = {
    totalTokens: 0,
    totalCost: 0,
    tokensByModel: {},
    costByModel: {},
};

async function renderUsagePanel() {
    let renderer: any;
    await act(async () => {
        renderer = TestRenderer.create(<UsagePanel />);
    });
    await act(async () => {
        await Promise.resolve();
    });
    return renderer;
}

function textValue(node: { props: { children?: unknown } }): string {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
}

describe('UsagePanel', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.credentials = { token: 'test' };
        mocks.currentMachineId = null;
        mocks.extraSessions = {};
        mocks.currentCodexProfileId = null;
        mocks.language = 'en';
        mocks.machines = [];
        mocks.codexProfiles = [];
        mocks.getUsageForPeriod.mockReset();
        mocks.calculateTotals.mockReset();
        mocks.machineRPC.mockReset();
        mocks.machineRPC.mockResolvedValue({ type: 'success' });
        mocks.calculateTotals.mockReturnValue(emptyTotals);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('keeps the 53-week grid within an extremely narrow container', () => {
        const width = 180;
        const metrics = getCodexHeatmapCellMetrics(width);

        expect(53 * metrics.cellSize + 52 * metrics.gap).toBeLessThanOrEqual(width);
    });

    it('removes month labels that would overlap at narrow widths', () => {
        const labels = [
            { key: '2025-09', label: 'Sep', weekIndex: 0 },
            { key: '2025-10', label: 'Oct', weekIndex: 1 },
            { key: '2025-11', label: 'Nov', weekIndex: 5 },
        ];

        expect(filterCodexHeatmapMonthLabels(labels, 6).map((label) => label.key))
            .toEqual(['2025-09', '2025-11']);
    });

    it('shows a Codex sync state instead of empty API usage metrics', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        const renderer = await renderUsagePanel();

        const tablists = renderer.root.findAllByType('View')
            .filter((node: any) => node.props.accessibilityRole === 'tablist');
        const tabs = renderer.root.findAllByType('Pressable')
            .filter((node: any) => node.props.accessibilityRole === 'tab');
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(tablists).toHaveLength(0);
        expect(tabs).toHaveLength(0);
        expect(texts).toContain('codexAccounts.quotaUnknown');
        expect(texts).not.toContain('usage.noData');

        act(() => renderer.unmount());
    });

    it('does not show the API loading spinner once Codex data is visible', async () => {
        mocks.getUsageForPeriod.mockReturnValue(new Promise(() => {}));
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: 200,
                    latestEvent: {
                        rateLimits: {
                            planType: 'pro',
                            primary: { usedPercent: 49, windowMinutes: 10080 },
                        },
                    },
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).not.toContain('51%');
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('switches account quota while preserving the current machine local activity', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.codexProfiles = [
            {
                id: '00000000-0000-4000-8000-000000000001', displayName: 'Codex · 5C7D', status: 'available', credentialVersion: 1,
                createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastValidatedAt: '2026-09-01T00:00:00.000Z',
                quota: { state: 'current', remainingPercent: 77, weeklyResetsAt: '2026-09-19T09:15:00.000Z', observedAt: '2026-09-14T09:00:00.000Z' },
            },
            {
                id: '00000000-0000-4000-8000-000000000002', displayName: 'Codex · 8A6C', status: 'available', credentialVersion: 1,
                createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastValidatedAt: '2026-09-01T00:00:00.000Z',
                quota: { state: 'current', remainingPercent: 98, weeklyResetsAt: '2026-09-19T08:15:00.000Z', observedAt: '2026-09-14T09:05:00.000Z' },
            },
        ];
        mocks.currentMachineId = 'current-machine';
        mocks.currentCodexProfileId = mocks.codexProfiles[1].id;
        const day = (date: string, totalTokens: number) => ({
            date, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
            totalTokens, tokenCountEvents: 1, sessions: 1, totalOnlyTokens: 0,
        });
        mocks.machines = [{
            id: 'current-machine',
            daemonState: {
                codexUsage: { source: 'codex-session-jsonl', scannedAt: Date.UTC(2026, 8, 14), days: [day('2026-09-14', 300)] },
                codexAccountUsage: [
                    { profileId: mocks.codexProfiles[0].id, usage: { source: 'codex-session-jsonl', scannedAt: Date.UTC(2026, 8, 14), days: [day('2026-09-14', 100)] } },
                    { profileId: mocks.codexProfiles[1].id, usage: { source: 'codex-session-jsonl', scannedAt: Date.UTC(2026, 8, 14), days: [day('2026-09-14', 900)] } },
                ],
            },
        }];

        const renderer = await renderUsagePanel();
        expect(renderer.root.findAllByType('Text').map(textValue)).toContain('98%');

        expect(renderer.root.findAllByProps({ testID: 'codex-usage-scope-all' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'codex-usage-scope-unattributed' })).toHaveLength(0);
        const initialLabel = renderer.root.findByProps({ testID: 'codex-usage-day-2026-09-14' }).props.accessibilityLabel;
        expect(initialLabel).toContain('"tokens":"300"');
        const firstAccount = renderer.root.findByProps({ testID: `codex-usage-scope-${mocks.codexProfiles[0].id}` });
        act(() => firstAccount.props.onPress());
        let texts = renderer.root.findAllByType('Text').map(textValue);
        expect(texts).toContain('77%');
        expect(texts).toContain('Codex · 5C7D');
        expect(texts.some((value: string) => value.includes('"tokens":"300"'))).toBe(true);

        const secondAccount = renderer.root.findByProps({ testID: `codex-usage-scope-${mocks.codexProfiles[1].id}` });
        act(() => secondAccount.props.onPress());
        texts = renderer.root.findAllByType('Text').map(textValue);
        expect(texts).toContain('98%');
        expect(texts).toContain('Codex · 8A6C');
        expect(texts.some((value: string) => value.includes('"tokens":"300"'))).toBe(true);

        act(() => renderer.unmount());
    });

    it('shows only local activity and no log-derived quota when account metadata is unavailable', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        const day = (totalTokens: number) => ({
            date: '2026-09-14', inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
            totalTokens, tokenCountEvents: 1, sessions: 1, totalOnlyTokens: 0,
        });
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl', scannedAt: Date.UTC(2026, 8, 14), days: [day(300)],
                    latestEvent: { rateLimits: { planType: 'pro', primary: { usedPercent: 49, windowMinutes: 10080 } } },
                },
                codexAccountUsage: [{
                    profileId: '00000000-0000-4000-8000-000000000001',
                    usage: { source: 'codex-session-jsonl', scannedAt: Date.UTC(2026, 8, 14), days: [day(100)] },
                }],
            },
        }];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).not.toContain('51%');
        expect(renderer.root.findByProps({ testID: 'codex-usage-day-2026-09-14' }).props.accessibilityLabel)
            .toContain('"tokens":"300"');

        act(() => renderer.unmount());
    });

    it('uses semantic surface states for Codex account scope chips', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.codexProfiles = [{
            id: '00000000-0000-4000-8000-000000000001', displayName: 'Codex · 5C7D', status: 'available', credentialVersion: 1,
            createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastValidatedAt: null,
            quota: { state: 'unknown', remainingPercent: null, weeklyResetsAt: null, observedAt: null },
        }];

        const renderer = await renderUsagePanel();
        const selectedAccount = renderer.root.findByProps({ testID: `codex-usage-scope-${mocks.codexProfiles[0].id}` });

        expect(typeof selectedAccount.props.style).toBe('function');
        expect(selectedAccount.props.style({ pressed: false })).toContainEqual(expect.objectContaining({ backgroundColor: appThemes.ginghamDark.colors.surface }));
        expect(selectedAccount.props.style({ pressed: true })).toContainEqual(expect.objectContaining({ backgroundColor: appThemes.ginghamDark.colors.surfacePressed }));
        expect(selectedAccount.props.style({ pressed: false })).toContainEqual(expect.objectContaining({ backgroundColor: appThemes.ginghamDark.colors.surfaceSelected }));

        act(() => renderer.unmount());
    });

    it('keeps local history visible even when the selected account quota is unknown', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.codexProfiles = [{
            id: '00000000-0000-4000-8000-000000000001', displayName: 'Codex · 5C7D', status: 'available', credentialVersion: 1,
            createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', lastValidatedAt: null,
            quota: { state: 'unknown', remainingPercent: null, weeklyResetsAt: null, observedAt: null },
        }];
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl', scannedAt: Date.UTC(2026, 8, 14),
                    days: [{
                        date: '2026-09-14', inputTokens: 300, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
                        totalTokens: 300, tokenCountEvents: 1, sessions: 1, totalOnlyTokens: 0,
                    }],
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).toContain('codexAccounts.quotaUnknown');
        expect(texts.some((value: string) => value.includes('"tokens":"300"'))).toBe(true);

        act(() => renderer.unmount());
    });

    it.each([
        ['current', 'current', true, '100'],
        ['missing', 'missing', false, null],
        ['ambiguous', null, true, null],
    ] as const)('isolates local history with %s machine context', async (_, currentId, active, expected) => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.currentMachineId = currentId;
        mocks.machines = ['current', 'other'].map((id, index) => ({
            id, active,
            daemonState: { codexUsage: {
                source: 'codex-session-jsonl', scannedAt: Date.UTC(2026, 8, 14),
                days: [{ date: '2026-09-14', totalTokens: (index + 1) * 100, sessions: 1 }],
            } },
        }));
        const renderer = await renderUsagePanel();
        const cells = renderer.root.findAllByProps({ testID: 'codex-usage-day-2026-09-14' });
        if (expected) {
            expect(cells).toHaveLength(1);
            expect(cells[0].props.accessibilityLabel).toContain(`"tokens":"${expected}"`);
            expect(mocks.machineRPC).toHaveBeenCalledTimes(1);
            expect(mocks.machineRPC.mock.calls[0][0]).toBe('current');
        } else {
            expect(cells).toHaveLength(0);
            expect(mocks.machineRPC).not.toHaveBeenCalled();
        }
        act(() => renderer.unmount());
    });

    it('uses explicit session context and resets the selected day when changing machines', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.currentMachineId = 'current';
        mocks.extraSessions = { explicit: { metadata: { machineId: 'other' } } };
        mocks.machines = ['current', 'other'].map((id, index) => ({
            id, active: true,
            daemonState: { codexUsage: {
                source: 'codex-session-jsonl', scannedAt: Date.UTC(2026, 8, 14),
                days: [{ date: '2026-09-14', totalTokens: (index + 1) * 100, sessions: 1 }],
            } },
        }));
        const renderer = await renderUsagePanel();
        act(() => renderer.root.findByProps({ testID: 'codex-usage-day-2026-09-13' }).props.onPress());
        mocks.machineRPC.mockClear();
        await act(async () => renderer.update(<UsagePanel sessionId="explicit" />));
        const day = renderer.root.findByProps({ testID: 'codex-usage-day-2026-09-14' });
        expect(day.props.accessibilityLabel).toContain('"tokens":"200"');
        expect(day.props.accessibilityState.selected).toBe(true);
        expect(mocks.machineRPC).toHaveBeenCalledTimes(1);
        expect(mocks.machineRPC.mock.calls[0][0]).toBe('other');
        act(() => renderer.unmount());
    });

    it('requests a fresh Codex usage snapshot from the current session machine', async () => {
        mocks.currentMachineId = 'current-machine';
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [{
            id: 'current-machine',
            active: true,
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: 200,
                    latestEvent: {
                        rateLimits: {
                            planType: 'pro',
                            primary: { usedPercent: 0, windowMinutes: 300 },
                        },
                    },
                },
            },
        }];

        const renderer = await renderUsagePanel();

        expect(mocks.machineRPC).toHaveBeenCalledWith(
            'current-machine',
            'refresh-codex-usage',
            {},
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );

        act(() => renderer.unmount());
    });

    it('requests a fresh snapshot from the active machine when no session is open', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [{
            id: 'active-machine',
            active: true,
            activeAt: 300,
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: 200,
                    latestEvent: {
                        rateLimits: {
                            primary: { usedPercent: 12, windowMinutes: 300 },
                        },
                    },
                },
            },
        }];

        const renderer = await renderUsagePanel();

        expect(mocks.machineRPC).toHaveBeenCalledWith(
            'active-machine',
            'refresh-codex-usage',
            {},
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );

        act(() => renderer.unmount());
    });

    it('keeps Codex data visible when the API usage request fails', async () => {
        consoleErrorSpy.mockImplementation(() => {});
        mocks.getUsageForPeriod.mockRejectedValue(new Error('offline'));
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: 200,
                    latestEvent: {
                        rateLimits: {
                            planType: 'pro',
                            primary: { usedPercent: 49, windowMinutes: 10080 },
                        },
                    },
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).not.toContain('51%');
        expect(texts).toContain('Failed to load usage data');

        act(() => renderer.unmount());
    });

    it('uses the same selected-tab semantics for token and cost charts', async () => {
        const usage = [{
            timestamp: 1,
            tokens: { 'test-model': 12 },
            cost: { 'test-model': 0.01 },
            reportCount: 1,
        }];
        mocks.getUsageForPeriod.mockResolvedValue({ usage });
        mocks.calculateTotals.mockReturnValue({
            totalTokens: 12,
            totalCost: 0.01,
            tokensByModel: { 'test-model': 12 },
            costByModel: { 'test-model': 0.01 },
        });
        const renderer = await renderUsagePanel();

        const tablists = renderer.root.findAllByType('View')
            .filter((node: any) => node.props.accessibilityRole === 'tablist');
        const metricTabs = renderer.root.findAllByType('Pressable')
            .filter((node: any) => node.props.accessibilityRole === 'tab')
            .filter((node: any) => {
                const text = node.findAllByType('Text').map(textValue);
                return text.includes('usage.tokens') || text.includes('usage.cost');
            });

        expect(tablists).toHaveLength(2);
        expect(metricTabs.map((node: any) => node.props['aria-selected'])).toEqual([true, false]);

        act(() => metricTabs[1].props.onPress());
        const updatedMetricTabs = renderer.root.findAllByType('Pressable')
            .filter((node: any) => node.props.accessibilityRole === 'tab')
            .filter((node: any) => {
                const text = node.findAllByType('Text').map(textValue);
                return text.includes('usage.tokens') || text.includes('usage.cost');
            });
        expect(updatedMetricTabs.map((node: any) => node.props['aria-selected'])).toEqual([false, true]);

        act(() => renderer.unmount());
    });

    it('ends the initial loading state when credentials are unavailable', async () => {
        mocks.credentials = null;
        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).toContain('Not authenticated');
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('does not present a local log quota as an account balance', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: 200,
                    latestEvent: {
                        rateLimits: {
                            planType: 'pro',
                            primary: {
                                usedPercent: 49,
                                windowMinutes: 10080,
                                resetsAt: 1_788_452_692,
                            },
                        },
                    },
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).not.toContain('51%');
        expect(texts).not.toContain('usage.totalTokens');
        expect(texts).not.toContain('usage.noData');

        act(() => renderer.unmount());
    });

    it('fits all 365 days into a narrow heatmap instead of hiding earlier months offscreen', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: Date.UTC(2026, 7, 30, 12),
                    days: [
                        {
                            date: '2025-08-31',
                            inputTokens: 50,
                            cachedInputTokens: 0,
                            outputTokens: 10,
                            reasoningOutputTokens: 2,
                            totalTokens: 60,
                            tokenCountEvents: 1,
                            sessions: 1,
                            totalOnlyTokens: 0,
                        },
                        {
                            date: '2026-08-18',
                            inputTokens: 100,
                            cachedInputTokens: 0,
                            outputTokens: 20,
                            reasoningOutputTokens: 5,
                            totalTokens: 120,
                            tokenCountEvents: 1,
                            sessions: 1,
                            totalOnlyTokens: 0,
                        },
                        {
                            date: '2026-08-30',
                            inputTokens: 500,
                            cachedInputTokens: 0,
                            outputTokens: 80,
                            reasoningOutputTokens: 40,
                            totalTokens: 580,
                            tokenCountEvents: 2,
                            sessions: 2,
                            totalOnlyTokens: 0,
                        },
                    ],
                    latestEvent: {
                        rateLimits: {
                            primary: { usedPercent: 49, windowMinutes: 10080 },
                        },
                    },
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const heatmap = renderer.root.findByProps({ testID: 'codex-usage-heatmap' });
        act(() => heatmap.props.onLayout({ nativeEvent: { layout: { width: 358 } } }));

        const cells = renderer.root.findAll((node: any) => (
            typeof node.props.testID === 'string' && node.props.testID.startsWith('codex-usage-day-')
        ));
        const texts = renderer.root.findAllByType('Text').map(textValue);

        const heatmapGrid = renderer.root.findByProps({ testID: 'codex-usage-heatmap-grid' });
        const monthLabels = renderer.root.findAllByType('Text').filter((node: any) => (
            Array.isArray(node.props.style)
            && node.props.style.some((style: any) => style?.position === 'absolute' && style?.top === 0)
        ));

        expect(cells).toHaveLength(365);
        expect(cells.some((cell: any) => cell.props.testID === 'codex-usage-day-2025-08-31')).toBe(true);
        expect(cells.some((cell: any) => cell.props.testID === 'codex-usage-day-2025-09-01')).toBe(true);
        expect(cells.some((cell: any) => cell.props.testID === 'codex-usage-day-2026-08-18')).toBe(true);
        expect(cells.some((cell: any) => cell.props.testID === 'codex-usage-day-2026-08-19')).toBe(true);
        expect(cells.every((cell: any) => {
            const styles = typeof cell.props.style === 'function'
                ? cell.props.style({ pressed: false })
                : cell.props.style;
            return styles.some((style: any) => style?.width === 5 && style?.height === 5)
                && styles.every((style: any) => style?.flex === undefined);
        })).toBe(true);
        expect(renderer.root.findAllByProps({ testID: 'codex-usage-heatmap-scroll' })).toHaveLength(0);
        expect(heatmapGrid.props.style).toContainEqual({ gap: 1 });
        expect(heatmapGrid?.children).toHaveLength(53);
        expect(renderer.root.findAll((node: any) => (
            typeof node.props.testID === 'string'
            && node.props.testID.startsWith('codex-usage-week-')
        ))).toHaveLength(53);
        expect(monthLabels).toHaveLength(12);
        expect(renderer.root.findAll((node: any) => (
            typeof node.props.testID === 'string'
            && node.props.testID.startsWith('codex-usage-month-')
        ))).toHaveLength(12);
        expect(monthLabels.find((label: any) => textValue(label) === 'Sep')?.props.style)
            .toContainEqual({ left: 0 });
        expect(texts.some((text: string) => text.startsWith('machine.codexUsageHeatmapDay:'))).toBe(true);

        act(() => renderer.unmount());
    });

    it('keeps low-intensity opacity off selected and pressed heatmap surfaces', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: Date.UTC(2026, 7, 30, 12),
                    days: [
                        {
                            date: '2026-08-29',
                            inputTokens: 1,
                            cachedInputTokens: 0,
                            outputTokens: 0,
                            reasoningOutputTokens: 0,
                            totalTokens: 1,
                            tokenCountEvents: 1,
                            sessions: 1,
                            totalOnlyTokens: 0,
                        },
                        {
                            date: '2026-08-30',
                            inputTokens: 500,
                            cachedInputTokens: 0,
                            outputTokens: 80,
                            reasoningOutputTokens: 40,
                            totalTokens: 580,
                            tokenCountEvents: 2,
                            sessions: 2,
                            totalOnlyTokens: 0,
                        },
                    ],
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const selected = renderer.root.find((node: any) => node.props.testID === 'codex-usage-day-2026-08-30');

        expect(typeof selected.props.style).toBe('function');
        const selectedStyles = selected.props.style({ pressed: false });
        const pressedStyles = selected.props.style({ pressed: true });
        expect(selectedStyles.some((style: any) => style?.backgroundColor === '#283544')).toBe(true);
        expect(pressedStyles.some((style: any) => style?.backgroundColor === '#1F2A38')).toBe(true);

        const lowIntensity = renderer.root.find((node: any) => node.props.testID === 'codex-usage-day-2026-08-29');
        expect(lowIntensity.props.style({ pressed: false })).toContainEqual({ opacity: 0.28 });
        expect(lowIntensity.props.style({ pressed: true }))
            .not.toEqual(expect.arrayContaining([expect.objectContaining({ opacity: expect.any(Number) })]));

        act(() => lowIntensity.props.onPress());
        const selectedLowIntensity = renderer.root.find(
            (node: any) => node.props.testID === 'codex-usage-day-2026-08-29',
        );
        expect(selectedLowIntensity.props.style({ pressed: false }))
            .not.toEqual(expect.arrayContaining([expect.objectContaining({ opacity: expect.any(Number) })]));
        expect(selectedLowIntensity.props.style({ pressed: false }))
            .toEqual(expect.arrayContaining([expect.objectContaining({ backgroundColor: '#283544' })]));

        act(() => renderer.unmount());
    });

    it('formats month labels with the selected Paws language', async () => {
        mocks.language = 'zh-Hans';
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: Date.UTC(2026, 7, 30, 12),
                    days: [{
                        date: '2026-08-30',
                        inputTokens: 10,
                        cachedInputTokens: 0,
                        outputTokens: 0,
                        reasoningOutputTokens: 0,
                        totalTokens: 10,
                        tokenCountEvents: 1,
                        sessions: 1,
                        totalOnlyTokens: 0,
                    }],
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const monthLabels = renderer.root.findAllByType('Text')
            .filter((node: any) => Array.isArray(node.props.style))
            .map(textValue);

        expect(monthLabels).toContain('9月');
        expect(monthLabels).not.toContain('Sep');

        act(() => renderer.unmount());
    });

    it('formats Simplified Chinese Codex activity in yi and says token instead of 令牌', async () => {
        mocks.language = 'zh-Hans';
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [{
            id: 'current-machine',
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: Date.UTC(2026, 8, 6, 12),
                    days: [{
                        date: '2026-09-06',
                        inputTokens: 625_510_000,
                        cachedInputTokens: 0,
                        outputTokens: 0,
                        reasoningOutputTokens: 0,
                        totalTokens: 625_510_000,
                        tokenCountEvents: 1,
                        sessions: 86,
                        totalOnlyTokens: 0,
                    }],
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).toContain('2026-09-06：6.26 亿 token · 86 个会话');
        expect(texts.some((text: string) => text.includes('令牌'))).toBe(false);
        expect(zhHans.machine.codexUsageHeatmapDay({
            date: '2026-09-06',
            tokens: '6.26 亿',
            sessions: 86,
        })).toBe('2026-09-06：6.26 亿 token · 86 个会话');

        act(() => renderer.unmount());
    });

    it('previews each heatmap day on web hover without requiring a click', async () => {
        mocks.language = 'zh-Hans';
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        const usageDay = (date: string, totalTokens: number, sessions: number) => ({
            date,
            inputTokens: totalTokens,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens,
            tokenCountEvents: 1,
            sessions,
            totalOnlyTokens: 0,
        });
        mocks.machines = [{
            id: 'current-machine',
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: Date.UTC(2026, 8, 6, 12),
                    days: [
                        usageDay('2026-09-05', 240_000_000, 12),
                        usageDay('2026-09-06', 625_510_000, 86),
                    ],
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const hoveredCell = renderer.root.findByProps({ testID: 'codex-usage-day-2026-09-05' });

        expect(typeof hoveredCell.props.onHoverIn).toBe('function');
        act(() => hoveredCell.props.onHoverIn());

        const texts = renderer.root.findAllByType('Text').map(textValue);
        expect(texts).toContain('2026-09-05：2.40 亿 token · 12 个会话');
        const hoveredStyles = renderer.root
            .findByProps({ testID: 'codex-usage-day-2026-09-05' })
            .props.style({ pressed: false });
        expect(hoveredStyles).toContainEqual({ transform: [{ scale: 1.16 }], zIndex: 1 });
        expect(hoveredStyles)
            .not.toEqual(expect.arrayContaining([expect.objectContaining({ opacity: expect.any(Number) })]));

        act(() => hoveredCell.props.onHoverOut());
        expect(renderer.root.findAllByType('Text').map(textValue))
            .toContain('2026-09-06：6.26 亿 token · 86 个会话');

        act(() => renderer.unmount());
    });

    it('uses four discrete intensity levels for active heatmap days', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        const usageDay = (date: string, totalTokens: number) => ({
            date,
            inputTokens: totalTokens,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens,
            tokenCountEvents: 1,
            sessions: 1,
            totalOnlyTokens: 0,
        });
        mocks.machines = [{
            daemonState: {
                codexUsage: {
                    source: 'codex-session-jsonl',
                    scannedAt: Date.UTC(2026, 7, 30, 12),
                    days: [
                        usageDay('2026-08-26', 100),
                        usageDay('2026-08-27', 1),
                        usageDay('2026-08-28', 9),
                        usageDay('2026-08-29', 36),
                        usageDay('2026-08-30', 100),
                    ],
                },
            },
        }];

        const renderer = await renderUsagePanel();
        const opacities = ['2026-08-27', '2026-08-28', '2026-08-29', '2026-08-26'].map((date) => {
            const cell = renderer.root.find((node: any) => node.props.testID === `codex-usage-day-${date}`);
            const styles = cell.props.style({ pressed: false });
            return styles.find((style: any) => typeof style?.opacity === 'number')?.opacity;
        });

        expect(opacities).toEqual([0.28, 0.5, 0.72, 1]);

        act(() => renderer.unmount());
    });

    it('ignores an older request that resolves after the latest session request', async () => {
        let resolveFirst!: (value: { usage: unknown[] }) => void;
        let resolveSecond!: (value: { usage: unknown[] }) => void;
        const firstRequest = new Promise<{ usage: unknown[] }>((resolve) => {
            resolveFirst = resolve;
        });
        const secondRequest = new Promise<{ usage: unknown[] }>((resolve) => {
            resolveSecond = resolve;
        });
        mocks.getUsageForPeriod.mockImplementation((_credentials: unknown, _period: unknown, sessionId: string) => (
            sessionId === 'first' ? firstRequest : secondRequest
        ));

        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<UsagePanel sessionId="first" />);
        });
        await act(async () => {
            renderer.update(<UsagePanel sessionId="second" />);
        });

        const latestUsage = [{
            timestamp: 2,
            tokens: { latest: 5 },
            cost: { latest: 0.02 },
            reportCount: 1,
        }];
        await act(async () => {
            resolveSecond({ usage: latestUsage });
            await Promise.resolve();
        });
        expect(renderer.root.findByType('UsageChart').props.data).toEqual(latestUsage);

        const staleUsage = [{
            timestamp: 1,
            tokens: { stale: 9 },
            cost: { stale: 0.09 },
            reportCount: 1,
        }];
        await act(async () => {
            resolveFirst({ usage: staleUsage });
            await Promise.resolve();
        });
        expect(renderer.root.findByType('UsageChart').props.data).toEqual(latestUsage);

        act(() => renderer.unmount());
    });
});
