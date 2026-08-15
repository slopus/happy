import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    firstOptionFocus: vi.fn(),
    keydownHandler: null as ((event: any) => void) | null,
    triggerFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const Pressable = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({
            focus: props.testID === 'session-composer-permission-trigger'
                ? mocks.triggerFocus
                : props.testID === 'session-composer-permission-option-confirm'
                    ? mocks.firstOptionFocus
                    : vi.fn(),
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(120, 700, 140, 32);
            },
        }), [props.testID]);
        return ReactModule.createElement('Pressable', props, props.children);
    });
    const Modal = (props: any) => props.visible
        ? ReactModule.createElement('Modal', props, props.children)
        : null;

    return {
        Modal,
        Platform: { OS: 'web' },
        Pressable,
        Text: 'Text',
        View: 'View',
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({
    t: (key: string) => ({
        'agentInput.taskPermission.title': 'Task permissions',
        'agentInput.taskPermission.confirm': 'Needs confirmation',
        'agentInput.taskPermission.confirmShort': 'Ask first',
        'agentInput.taskPermission.confirmDescription': 'Uses the agent confirmation flow for actions that need extra permission. Device and outer sandbox limits still apply.',
        'agentInput.taskPermission.fullAccess': 'Full access',
        'agentInput.taskPermission.fullAccessShort': 'Full',
        'agentInput.taskPermission.fullAccessDescription': 'Bypasses agent confirmations where supported. Device and outer sandbox limits still apply.',
        'agentInput.taskPermission.changesNextMessages': 'Applies to messages sent after this change.',
        'agentInput.taskPermission.unavailable': 'Unavailable',
    } as Record<string, string>)[key] ?? key,
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            button: { primary: { background: '#08f' } },
            divider: '#444',
            input: { background: '#111' },
            shadow: { color: '#000', opacity: 0.2 },
            surfaceHigh: '#222',
            text: '#fff',
            textSecondary: '#aaa',
            warning: '#f90',
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: any) => factory(theme),
        },
        useUnistyles: () => ({ theme }),
    };
});

import { SessionComposerPermissionSelector } from './SessionComposerPermissionSelector';

describe('SessionComposerPermissionSelector', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let renderer: any;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.keydownHandler = null;
        vi.stubGlobal('window', {
            addEventListener: vi.fn((event: string, handler: (event: any) => void) => {
                if (event === 'keydown') mocks.keydownHandler = handler;
            }),
            removeEventListener: vi.fn(),
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) {
            act(() => renderer.unmount());
        }
        renderer = undefined;
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('opens a stable two-level radio dialog with explicit risk descriptions', () => {
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerPermissionSelector
                    online
                    supported
                    level="confirm"
                    unavailableReason={null}
                    onLevelChange={vi.fn()}
                />,
            );
        });

        const trigger = renderer.root.findByProps({ testID: 'session-composer-permission-trigger' });
        expect(trigger.props.accessibilityRole).toBe('button');
        expect(trigger.props.accessibilityLabel).toBe('Task permissions: Needs confirmation');
        expect(trigger.props['aria-expanded']).toBe(false);
        expect(renderer.root.findByProps({ testID: 'session-composer-permission-trigger-label' }).props.children)
            .toBe('Ask first');

        act(() => trigger.props.onPress());
        const picker = renderer.root.findByProps({ testID: 'session-composer-permission-picker' });
        expect(picker.props.role).toBe('dialog');
        expect(renderer.root.findByProps({ testID: 'session-composer-permission-trigger' }).props['aria-expanded']).toBe(true);

        const confirmOption = renderer.root.findByProps({ testID: 'session-composer-permission-option-confirm' });
        const fullOption = renderer.root.findByProps({ testID: 'session-composer-permission-option-full-access' });
        expect(confirmOption.props.accessibilityRole).toBe('radio');
        expect(confirmOption.props.accessibilityState).toEqual({ checked: true });
        expect(confirmOption.props.accessibilityLabel).toContain('Needs confirmation.');
        expect(confirmOption.props.accessibilityLabel).toContain('agent confirmation flow');
        expect(confirmOption.props.accessibilityLabel).toContain('outer sandbox limits still apply');
        expect(fullOption.props.accessibilityRole).toBe('radio');
        expect(fullOption.props.accessibilityState).toEqual({ checked: false });
        expect(fullOption.props.accessibilityLabel).toContain('Full access.');
        expect(fullOption.props.accessibilityLabel).toContain('where supported');
        expect(fullOption.props.accessibilityLabel).toContain('outer sandbox limits still apply');

        act(() => vi.runOnlyPendingTimers());
        expect(mocks.firstOptionFocus).toHaveBeenCalledOnce();
    });

    it('closes on Escape and restores focus to its trigger', () => {
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerPermissionSelector
                    online
                    supported
                    level="confirm"
                    unavailableReason={null}
                    onLevelChange={vi.fn()}
                />,
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-permission-trigger' }).props.onPress());
        act(() => vi.runOnlyPendingTimers());

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        act(() => mocks.keydownHandler?.({ key: 'Escape', preventDefault, stopPropagation }));
        expect(renderer.root.findAllByProps({ testID: 'session-composer-permission-picker' })).toHaveLength(0);

        act(() => vi.runOnlyPendingTimers());
        expect(mocks.triggerFocus).toHaveBeenCalledOnce();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
    });

    it('restores trigger focus when the full-access confirmation is cancelled', async () => {
        const onLevelChange = vi.fn().mockResolvedValue(false);
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerPermissionSelector
                    online
                    supported
                    level="confirm"
                    unavailableReason={null}
                    onLevelChange={onLevelChange}
                />,
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-permission-trigger' }).props.onPress());

        await act(async () => {
            renderer.root.findByProps({ testID: 'session-composer-permission-option-full-access' }).props.onPress();
            await Promise.resolve();
        });
        act(() => vi.runOnlyPendingTimers());

        expect(onLevelChange).toHaveBeenCalledWith('full-access');
        expect(mocks.triggerFocus).toHaveBeenCalled();
        expect(renderer.root.findAllByProps({ testID: 'session-composer-permission-picker' })).toHaveLength(0);
    });

    it('disables unsupported agents with an accurate unavailable label and reason', () => {
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerPermissionSelector
                    online
                    supported={false}
                    level={null}
                    unavailableReason="This agent does not expose task permissions."
                    onLevelChange={vi.fn()}
                />,
            );
        });

        const trigger = renderer.root.findByProps({ testID: 'session-composer-permission-trigger' });
        expect(trigger.props.disabled).toBe(true);
        expect(trigger.props.accessibilityLabel).toBe('Task permissions: Unavailable');
        expect(trigger.props.accessibilityHint).toBe('This agent does not expose task permissions.');
        expect(renderer.root.findByProps({ testID: 'session-composer-permission-disabled-reason' }).props.children)
            .toBe('This agent does not expose task permissions.');
    });

    it('disables selection while offline without repeating the header status', () => {
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerPermissionSelector
                    online={false}
                    supported
                    level="full-access"
                    unavailableReason="Machine offline"
                    onLevelChange={vi.fn()}
                />,
            );
        });

        const trigger = renderer.root.findByProps({ testID: 'session-composer-permission-trigger' });
        expect(trigger.props.disabled).toBe(true);
        expect(trigger.props.accessibilityHint).toBe('Machine offline');
        expect(trigger.props.accessibilityLabel).toBe('Task permissions: Full access');
        expect(renderer.root.findByProps({ testID: 'session-composer-permission-trigger-label' }).props.children)
            .toBe('Full');
        expect(renderer.root.findAllByProps({ testID: 'session-composer-permission-disabled-reason' })).toHaveLength(0);
    });
});
