vi.mock('./ComposerReferenceChips', () => ({ ComposerReferenceChips: 'ComposerReferenceChips' }));
vi.mock('./ComposerContextPicker', () => ({ ComposerContextPicker: 'ComposerContextPicker' }));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path', Rect: 'Rect', Circle: 'Circle' }));
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Yoga, { type Node as YogaNode } from 'yoga-layout';
import { View } from 'react-native';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    hapticsLight: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const Pressable = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(120, 700, 40, 32);
            },
        }));
        return ReactModule.createElement('Pressable', props, props.children);
    });
    return {
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'ios',
            select: (values: Record<string, unknown>) => values.ios ?? values.default,
        },
        Pressable,
        Text: 'Text',
        View: 'View',
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('./AgentInputAttachmentStrip', () => ({ AgentInputAttachmentStrip: 'AgentInputAttachmentStrip' }));
vi.mock('./MultiTextInput', async () => {
    const ReactModule = await import('react');
    return {
        MULTI_TEXT_INPUT_FONT_SIZE: 16,
        MULTI_TEXT_INPUT_LINE_HEIGHT: 22,
        MultiTextInput: ReactModule.forwardRef<any, any>((props, ref) => {
            ReactModule.useImperativeHandle(ref, () => ({
                getText: () => '',
                setTextAndSelection: vi.fn(),
            }));
            return ReactModule.createElement('MultiTextInput', props);
        }),
    };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./haptics', () => ({ hapticsLight: mocks.hapticsLight, hapticsError: vi.fn() }));
vi.mock('./Shaker', async () => {
    const ReactModule = await import('react');
    return {
        Shaker: ReactModule.forwardRef<any, any>((props, ref) => {
            ReactModule.useImperativeHandle(ref, () => ({ shake: vi.fn() }));
            return ReactModule.createElement('Shaker', props, props.children);
        }),
    };
});
vi.mock('./StatusDot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('./autocomplete/useActiveWord', () => ({ useActiveWord: () => null }));
vi.mock('./autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, vi.fn(), vi.fn()],
}));
vi.mock('./AgentInputAutocomplete', () => ({ AgentInputAutocomplete: 'AgentInputAutocomplete' }));
vi.mock('./GitStatusBadge', () => ({ GitStatusBadge: 'GitStatusBadge', useHasMeaningfulGitStatus: () => false }));
vi.mock('@/sync/storage', () => ({ useSetting: () => false }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/desktopNavigationLayout', () => ({ supportsDesktopComposerModeSelector: () => false }));
vi.mock('./SessionComposerModeSelector', () => ({ SessionComposerModeSelector: 'SessionComposerModeSelector' }));
vi.mock('./LegacySessionComposerModeSelector', () => ({ SessionComposerModeSelector: 'SessionComposerModeSelector' }));
vi.mock('./SessionComposerPermissionSelector', () => ({ SessionComposerPermissionSelector: 'SessionComposerPermissionSelector' }));
vi.mock('./SessionComposerDirectorySelector', () => ({ SessionComposerDirectorySelector: 'SessionComposerDirectorySelector' }));
vi.mock('./composerPrimaryAction', () => ({ resolveComposerPrimaryAction: () => 'send' }));
vi.mock('@/hooks/useComposerAbortConfirmation', () => ({
    useComposerAbortConfirmation: () => ({ confirm: vi.fn(), handleEscape: vi.fn(), isArmed: false }),
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: true,
        colors: {
            button: {
                composer: { background: '#fff', disabled: '#777', tint: '#000' },
                primary: { background: '#fff', disabled: '#777', tint: '#000' },
                secondary: { tint: '#fff' },
            },
            divider: '#444',
            input: { background: '#111' },
            radio: { active: '#f90' },
            shadow: { color: '#000', opacity: 0.2 },
            success: '#0f0',
            surfaceHigh: '#222',
            surfacePressed: '#333',
            text: '#fff',
            textDestructive: '#f00',
            textSecondary: '#aaa',
            warning: '#f90',
            warningCritical: '#f00',
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: any) => typeof factory === 'function' ? factory(theme, {}) : factory,
        },
        useUnistyles: () => ({ theme }),
    };
});

import { MessageComposer } from './MessageComposer';

describe('MessageComposer capture controls', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });

    it.each([320, 360, 390, 430])('keeps fixed actions reachable with a long model at %sdp', (width) => {
        act(() => { renderer = TestRenderer.create(<MessageComposer mode="home" initialValue="draft" placeholder="Message" onSend={vi.fn()}
            leadingControls={<View testID="test-permission" />} trailingControls={<View testID="test-model" />} />); });
        const row = renderer.root.findByProps({ testID: 'composer-actions-row' });
        const flatten = (style: any): any => Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flatten)) : style ?? {};
        function nodeFor(style: any): YogaNode {
            const node = Yoga.Node.create();
            const value = flatten(style);
            if (value.flex !== undefined) node.setFlex(value.flex);
            if (value.flexBasis === 'auto') node.setFlexBasisAuto();
            if (value.flexShrink !== undefined) node.setFlexShrink(value.flexShrink);
            if (value.minWidth !== undefined) node.setMinWidth(value.minWidth);
            node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
            return node;
        }
        const root = nodeFor(row.props.style);
        root.setWidth(width - 46); // Home side insets, panel padding and borders.
        const left = nodeFor(row.children[0].props.style);
        const right = nodeFor(row.children[1].props.style);
        root.insertChild(left, 0); root.insertChild(right, 1);
        const add = Yoga.Node.create(); add.setWidth(36); add.setFlexShrink(0); left.insertChild(add, 0);
        const permission = Yoga.Node.create(); permission.setWidth(112); permission.setFlexShrink(0); left.insertChild(permission, 1);
        const model = Yoga.Node.create(); model.setWidth(280); model.setMinWidth(0); model.setFlexShrink(1); right.insertChild(model, 0);
        const send = Yoga.Node.create(); send.setWidth(40); send.setMargin(Yoga.EDGE_LEFT, 8); send.setFlexShrink(0); right.insertChild(send, 1);
        root.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
        expect(left.getComputedWidth()).toBeGreaterThanOrEqual(148);
        expect(right.getComputedLeft() + send.getComputedLeft() + send.getComputedWidth()).toBeLessThanOrEqual(width - 46);
        expect(model.getComputedWidth()).toBeGreaterThan(0);
        root.freeRecursive();
    });

    it('does not render the removed screenshot button', () => {
        act(() => {
            renderer = TestRenderer.create(React.createElement(MessageComposer, {
                mode: 'session',
                initialValue: '',
                placeholder: 'Message',
                onSend: vi.fn(),
                onCaptureScreenshot: vi.fn(),
            } as any));
        });

        expect(renderer.root.findAllByProps({
            accessibilityLabel: 'components.messageComposer.screenshot',
        })).toHaveLength(0);
    });
});
