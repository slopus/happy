import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer 没有随包发布 TypeScript 声明。
// @ts-expect-error 测试只使用 create/unmount 所需的最小接口。
import TestRenderer from 'react-test-renderer';
import { Platform } from 'react-native';

import QRTest from '@/app/(app)/dev/qr-test';
import SessionComposerDemo from '@/app/(app)/dev/session-composer';

const { theme } = vi.hoisted(() => ({
    theme: {
        colors: {
            input: {
                background: '#202020',
                placeholder: '#777777',
                text: '#f5f5f5',
            },
            button: {
                primary: {
                    background: '#00ff88',
                    disabled: '#303030',
                    tint: '#000000',
                },
            },
            divider: '#303030',
            header: {
                background: '#080808',
            },
            surface: '#101010',
            surfaceHigh: '#181818',
            text: '#f5f5f5',
            textSecondary: '#aaaaaa',
        },
    },
}));

vi.mock('react-native', () => ({
    Animated: {
        Value: class {},
        View: 'AnimatedView',
        parallel: () => ({ start: vi.fn() }),
        spring: () => ({}),
        timing: () => ({}),
    },
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    LayoutAnimation: {
        Presets: { easeInEaseOut: {} },
        configureNext: vi.fn(),
    },
    Modal: 'Modal',
    Platform: {
        OS: 'web',
        select: (values: Record<string, unknown>) => values.web ?? values.default,
    },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    TextInput: 'TextInput',
    TouchableWithoutFeedback: 'TouchableWithoutFeedback',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (value: typeof theme) => object)(theme)
            : factory,
    },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@/components/qr', () => ({ QRCode: 'QRCode' }));
vi.mock('@/components/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('@/components/MultiTextInput', () => ({
    MULTI_TEXT_INPUT_LINE_HEIGHT: 20,
    MultiTextInput: 'MultiTextInput',
}));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 960 } }));
vi.mock('@/components/modelModeOptions', () => ({
    getDefaultEffortKeyForModel: () => 'medium',
    getDefaultModelKey: () => 'default',
    getDefaultPermissionModeKey: () => 'default',
    getEffortLevelsForModel: () => [
        { key: 'low', name: 'Low' },
        { key: 'medium', name: 'Medium' },
    ],
    getHardcodedModelModes: () => [
        { key: 'default', name: 'Default' },
        { key: 'fast', name: 'Fast' },
    ],
    getHardcodedPermissionModes: () => [
        { key: 'default', name: 'Default' },
        { key: 'plan', name: 'Plan' },
    ],
    getSupportsWorktree: () => true,
}));
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    MaterialCommunityIcons: 'MaterialCommunityIcons',
    Octicons: 'Octicons',
}));
vi.mock('expo-constants', () => ({ default: { statusBarHeight: 0 } }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: 'KeyboardAvoidingView',
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 0 }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('二维码演示页', () => {
    it('为输入和二维码提供持久名称，并在空输入时显示安全空态', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<QRTest />);
        });

        const input = renderer.root.findByType('TextInput');
        expect(input.props.accessibilityLabel).toBe('devTools.customQrCode');

        const initialCodes = renderer.root.findAllByType('QRCode');
        expect(initialCodes).toHaveLength(17);
        for (const code of initialCodes) {
            expect(code.props.accessibilityLabel).toBeTypeOf('string');
        }

        act(() => {
            input.props.onChangeText('');
        });

        expect(renderer.root.findAllByType('QRCode')).toHaveLength(16);
        const texts = renderer.root.findAllByType('Text')
            .flatMap((node: any) => React.Children.toArray(node.props.children));
        expect(texts).toContain('devTools.enterDataHere');

        act(() => renderer.unmount());
    });
});

describe('会话编辑器演示页', () => {
    it('为配置触发器、选择器和输入提供稳定语义', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerDemo
                    agentIconSources={{
                        claude: 'icon',
                        codex: 'icon',
                        gemini: 'icon',
                        antigravity: 'icon', opencode: 'icon',
                        openclaw: 'icon',
                    }}
                />,
            );
        });

        const machine = renderer.root.findByProps({ testID: 'dev-composer-machine' });
        const path = renderer.root.findByProps({ testID: 'dev-composer-path' });
        const agent = renderer.root.findByProps({ testID: 'dev-composer-agent' });
        const permission = renderer.root.findByProps({ testID: 'dev-composer-permission' });
        const worktree = renderer.root.findByProps({ testID: 'dev-composer-worktree' });
        const input = renderer.root.findByType('MultiTextInput');

        for (const trigger of [machine, path, agent, permission, worktree]) {
            expect(trigger.props.accessibilityRole).toBe('button');
            expect(trigger.props.accessibilityLabel).toBeTypeOf('string');
        }
        expect(machine.props.accessibilityState).toMatchObject({ expanded: false });
        expect(input.props.accessibilityLabel).toBe('devTools.sessionComposerPrompt');

        act(() => {
            machine.props.onPress();
        });

        const popover = renderer.root.findByProps({ testID: 'dev-composer-picker' });
        const search = renderer.root.findByType('TextInput');
        const options = renderer.root
            .findAllByType('Pressable')
            .filter((node: any) => node.props.accessibilityRole === 'radio');
        expect(popover.props.role).toBe('dialog');
        expect(search.props.accessibilityLabel).toBe('devTools.searchMachines');
        expect(options).toHaveLength(3);
        expect(options.filter((node: any) => node.props['aria-checked'])).toHaveLength(1);

        act(() => renderer.unmount());
    });

    it('让空操作发送图标退出焦点顺序，并在输入时保留可恢复的配置状态', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerDemo
                    agentIconSources={{
                        claude: 'icon',
                        codex: 'icon',
                        gemini: 'icon',
                        antigravity: 'icon', opencode: 'icon',
                        openclaw: 'icon',
                    }}
                />,
            );
        });

        const input = renderer.root.findByType('MultiTextInput');
        const sendVisual = renderer.root.findByProps({ testID: 'dev-composer-send-visual' });
        expect(sendVisual.type).toBe('View');
        expect(sendVisual.props.accessible).toBe(false);
        expect(sendVisual.props.accessibilityRole).toBeUndefined();
        expect(sendVisual.props.onPress).toBeUndefined();
        expect(sendVisual.props.tabIndex).toBeUndefined();
        expect(sendVisual.findAllByType('Pressable')).toHaveLength(0);

        act(() => {
            input.props.onChangeText('本地演示');
        });

        const collapsed = renderer.root.findByProps({ testID: 'dev-composer-config-toggle' });
        expect(collapsed.props.accessibilityRole).toBe('button');
        expect(collapsed.props.accessibilityState).toMatchObject({ expanded: false });

        act(() => renderer.unmount());
    });

    it('让 Android picker 的关闭背景退出可访问树', () => {
        const mutablePlatform = Platform as unknown as { OS: string };
        mutablePlatform.OS = 'android';
        let renderer: any;

        try {
            act(() => {
                renderer = TestRenderer.create(
                    <SessionComposerDemo
                        agentIconSources={{
                            claude: 'icon',
                            codex: 'icon',
                            gemini: 'icon',
                            antigravity: 'icon', opencode: 'icon',
                            openclaw: 'icon',
                        }}
                    />,
                );
            });

            act(() => {
                renderer.root
                    .findByProps({ testID: 'dev-composer-machine' })
                    .props.onPress();
            });

            const backdrop = renderer.root.findByType('TouchableWithoutFeedback');
            expect(backdrop.props.accessible).toBe(false);
            expect(backdrop.props.focusable).toBe(false);
        } finally {
            if (renderer) {
                act(() => renderer.unmount());
            }
            mutablePlatform.OS = 'web';
        }
    });
});
