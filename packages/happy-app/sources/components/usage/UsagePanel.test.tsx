import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsagePanel } from './UsagePanel';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs the small create/unmount surface typed below.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    calculateTotals: vi.fn(),
    credentials: { token: 'test' } as { token: string } | null,
    getUsageForPeriod: vi.fn(),
    language: 'en',
    machines: [] as Array<{ daemonState: unknown }>,
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
    useAllMachines: () => mocks.machines,
}));
vi.mock('@/sync/apiUsage', () => ({
    getUsageForPeriod: mocks.getUsageForPeriod,
    calculateTotals: mocks.calculateTotals,
}));
vi.mock('./UsageChart', () => ({ UsageChart: 'UsageChart' }));
vi.mock('./UsageBar', () => ({ UsageBar: 'UsageBar' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/utils/errors', () => ({ HappyError: class HappyError extends Error {} }));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => mocks.language,
    t: (key: string, values?: Record<string, unknown>) => values
        ? `${key}:${JSON.stringify(values)}`
        : key,
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
        mocks.language = 'en';
        mocks.machines = [];
        mocks.getUsageForPeriod.mockReset();
        mocks.calculateTotals.mockReset();
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
        expect(texts).toContain('machine.codexUsageWaitingForDaemon');
        expect(texts).not.toContain('usage.noData');

        act(() => renderer.unmount());
    });

    it('shows Codex data while the API usage request is still loading', async () => {
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

        expect(texts).toContain('51%');
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);

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

        expect(texts).toContain('51%');
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

    it('shows the Codex rate limit from the freshest usage event', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [
            {
                daemonState: {
                    codexUsage: {
                        source: 'codex-session-jsonl',
                        scannedAt: 100,
                        latestEvent: {
                            timestamp: '2026-08-30T03:00:00.000Z',
                            rateLimits: {
                                planType: 'pro',
                                primary: {
                                    usedPercent: 83,
                                    windowMinutes: 10080,
                                    resetsAt: 1_788_452_692,
                                },
                            },
                        },
                    },
                },
            },
            {
                daemonState: {
                    codexUsage: {
                        source: 'codex-session-jsonl',
                        scannedAt: 200,
                        latestEvent: {
                            timestamp: '2026-08-30T02:00:00.000Z',
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
            },
        ];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).toContain('17%');
        expect(texts).toContain('PRO');
        expect(texts.some((text: string) => text.startsWith('machine.codexUsageResetsAt:'))).toBe(true);

        act(() => renderer.unmount());
    });

    it('uses an older valid quota when the newest machine event has no rate limits', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [
            {
                daemonState: {
                    codexUsage: {
                        source: 'codex-session-jsonl',
                        scannedAt: 300,
                        latestEvent: { timestamp: '2026-08-30T04:00:00.000Z' },
                    },
                },
            },
            {
                daemonState: {
                    codexUsage: {
                        source: 'codex-session-jsonl',
                        scannedAt: 200,
                        latestEvent: {
                            timestamp: '2026-08-30T03:00:00.000Z',
                            rateLimits: {
                                planType: 'pro',
                                primary: { usedPercent: 83, windowMinutes: 10080 },
                            },
                        },
                    },
                },
            },
        ];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).toContain('17%');
        expect(texts).toContain('PRO');

        act(() => renderer.unmount());
    });

    it('compares the source timestamps of retained quotas across machines', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        mocks.machines = [
            {
                daemonState: {
                    codexUsage: {
                        source: 'codex-session-jsonl',
                        scannedAt: 300,
                        latestEvent: {
                            timestamp: '2026-08-30T05:00:00.000Z',
                            rateLimitsTimestamp: '2026-08-30T03:00:00.000Z',
                            rateLimits: {
                                planType: 'pro',
                                primary: { usedPercent: 83, windowMinutes: 10080 },
                            },
                        },
                    },
                },
            },
            {
                daemonState: {
                    codexUsage: {
                        source: 'codex-session-jsonl',
                        scannedAt: 200,
                        latestEvent: {
                            timestamp: '2026-08-30T04:00:00.000Z',
                            rateLimitsTimestamp: '2026-08-30T04:00:00.000Z',
                            rateLimits: {
                                planType: 'plus',
                                primary: { usedPercent: 49, windowMinutes: 10080 },
                            },
                        },
                    },
                },
            },
        ];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).toContain('51%');
        expect(texts).toContain('PLUS');

        act(() => renderer.unmount());
    });

    it('prioritizes the Codex balance and hides empty API usage metrics', async () => {
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

        expect(texts).toContain('51%');
        expect(texts).not.toContain('usage.totalTokens');
        expect(texts).not.toContain('usage.noData');

        act(() => renderer.unmount());
    });

    it('renders a scrollable 365-day Codex activity heatmap as week columns with month labels', async () => {
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
        const cells = renderer.root.findAll((node: any) => (
            typeof node.props.testID === 'string' && node.props.testID.startsWith('codex-usage-day-')
        ));
        const texts = renderer.root.findAllByType('Text').map(textValue);

        const horizontalScrollViews = renderer.root.findAllByType('ScrollView')
            .filter((node: any) => node.props.horizontal === true);
        const heatmapGrid = renderer.root.findAllByType('View').find((node: any) => (
            node.props.style?.flexDirection === 'row'
            && node.props.style?.gap === 5
            && node.findAll((child: any) => (
                typeof child.props.testID === 'string'
                && child.props.testID.startsWith('codex-usage-day-')
            )).length === 365
        ));
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
            return styles.some((style: any) => style?.width === 14 && style?.height === 14)
                && styles.every((style: any) => style?.flex === undefined);
        })).toBe(true);
        expect(horizontalScrollViews).toHaveLength(1);
        expect(horizontalScrollViews[0].props.testID).toBe('codex-usage-heatmap-scroll');
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

    it('merges Codex activity from every machine without changing the freshest rate limit', async () => {
        mocks.getUsageForPeriod.mockResolvedValue({ usage: [] });
        const usageDay = (totalTokens: number, sessions: number) => ({
            date: '2026-08-30',
            inputTokens: totalTokens - 20,
            cachedInputTokens: 10,
            outputTokens: 20,
            reasoningOutputTokens: 5,
            totalTokens,
            tokenCountEvents: sessions,
            sessions,
            totalOnlyTokens: 0,
        });
        mocks.machines = [
            {
                daemonState: {
                    codexUsage: {
                        source: 'codex-session-jsonl',
                        scannedAt: Date.UTC(2026, 7, 30, 12),
                        days: [usageDay(200, 2)],
                        latestEvent: {
                            timestamp: '2026-08-30T03:00:00.000Z',
                            rateLimits: {
                                planType: 'pro',
                                primary: { usedPercent: 60, windowMinutes: 10080 },
                            },
                        },
                    },
                },
            },
            {
                daemonState: {
                    codexUsage: {
                        source: 'codex-session-jsonl',
                        scannedAt: Date.UTC(2026, 7, 30, 13),
                        days: [usageDay(300, 3)],
                        latestEvent: {
                            timestamp: '2026-08-30T02:00:00.000Z',
                            rateLimits: {
                                planType: 'pro',
                                primary: { usedPercent: 20, windowMinutes: 10080 },
                            },
                        },
                    },
                },
            },
        ];

        const renderer = await renderUsagePanel();
        const texts = renderer.root.findAllByType('Text').map(textValue);

        expect(texts).toContain('40%');
        expect(texts).toContain('machine.codexUsageHeatmapDay:{"date":"2026-08-30","tokens":"500","sessions":5}');

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
