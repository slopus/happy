import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FeaturesSettingsScreen from '@/app/(app)/settings/features';

// react-test-renderer 没有随包发布 TypeScript 声明。
// @ts-expect-error 测试只使用 create/unmount 所需的最小接口。
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/Item', () => ({
    Item: ({ rightElement }: { rightElement?: React.ReactNode }) => rightElement ?? null,
}));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/sync/storage', () => ({
    useSettingMutable: () => [false, vi.fn()],
    useLocalSettingMutable: () => [false, vi.fn()],
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { accent: '#00ff88' } } }),
}));

describe('FeaturesSettingsScreen 可访问语义', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('每个功能开关都使用对应的可见标题作为名称', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<FeaturesSettingsScreen />);
        });

        expect(renderer.root.findAllByType('Switch').map((node: any) => node.props.accessibilityLabel))
            .toEqual([
                'featuresInterface.fileDiffsSidebar',
                'settingsFeatures.groupToolCalls',
                'settingsFeatures.experimentalFeatures',
                'settingsFeatures.markdownCopyV2',
                'settingsFeatures.hideInactiveSessions',
                'featuresInterface.resumeSession',
                'settingsFeatures.disableAnalytics',
                'settingsFeatures.enterToSend',
            ]);

        act(() => renderer.unmount());
    });
});
