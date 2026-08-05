import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionComposerModeSelector } from './SessionComposerModeSelector';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('@/components/SessionConfigPanel', () => ({ PickerContent: 'PickerContent' }));
vi.mock('@/text', () => ({
    t: (key: string) => ({
        'agentInput.model.title': 'MODEL',
        'agentInput.effort.title': 'EFFORT',
        'newSession.machineOffline': 'offline',
        'settingsAccount.notAvailable': 'Not available',
    } as Record<string, string>)[key] ?? key,
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (theme: any) => object)({
                colors: {
                    divider: '#444',
                    input: { background: '#111' },
                    shadow: { color: '#000', opacity: 0.2 },
                    surfaceHigh: '#222',
                    text: '#fff',
                    textSecondary: '#aaa',
                },
            })
            : factory,
    },
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#aaa' } } }),
}));

const modelOptions = [
    { key: 'gpt-5.5', name: 'gpt-5.5' },
    { key: 'gpt-5.6-sol', name: 'gpt-5.6-sol' },
];
const effortOptions = [
    { key: 'medium', name: 'medium' },
    { key: 'xhigh', name: 'xhigh' },
];

describe('SessionComposerModeSelector', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('opens model and effort pickers independently', () => {
        const onModelChange = vi.fn();
        const onEffortChange = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={modelOptions[0]}
                    modelOptions={modelOptions}
                    effort={effortOptions[0]}
                    effortOptions={effortOptions}
                    onModelChange={onModelChange}
                    onEffortChange={onEffortChange}
                />,
            );
        });

        act(() => renderer.root.findByProps({ testID: 'session-composer-model-trigger' }).props.onPress());
        const modelPicker = renderer.root.findByType('PickerContent');
        expect(modelPicker.props.selectedKey).toBe('gpt-5.5');
        act(() => modelPicker.props.onSelect('gpt-5.6-sol'));
        expect(onModelChange).toHaveBeenCalledWith('gpt-5.6-sol');
        expect(onEffortChange).not.toHaveBeenCalled();

        act(() => renderer.root.findByProps({ testID: 'session-composer-effort-trigger' }).props.onPress());
        const effortPicker = renderer.root.findByType('PickerContent');
        expect(effortPicker.props.selectedKey).toBe('medium');
        act(() => effortPicker.props.onSelect('xhigh'));
        expect(onEffortChange).toHaveBeenCalledWith('xhigh');

        act(() => renderer.unmount());
    });

    it('disables both pickers and exposes the offline reason', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online={false}
                    model={modelOptions[0]}
                    modelOptions={modelOptions}
                    effort={effortOptions[0]}
                    effortOptions={effortOptions}
                    onModelChange={vi.fn()}
                    onEffortChange={vi.fn()}
                />,
            );
        });

        const modelTrigger = renderer.root.findByProps({ testID: 'session-composer-model-trigger' });
        const effortTrigger = renderer.root.findByProps({ testID: 'session-composer-effort-trigger' });
        expect(modelTrigger.props.disabled).toBe(true);
        expect(modelTrigger.props.accessibilityHint).toBe('offline');
        expect(effortTrigger.props.disabled).toBe(true);
        expect(effortTrigger.props.accessibilityHint).toBe('offline');
        expect(renderer.root.findByProps({ testID: 'session-composer-disabled-reason' }).props.children).toBe('offline');
        expect(renderer.root.findAllByType('PickerContent')).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('does not invent an effort control for an agent without effort support', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={modelOptions[0]}
                    modelOptions={[modelOptions[0]]}
                    effort={null}
                    effortOptions={[]}
                    onModelChange={vi.fn()}
                    onEffortChange={vi.fn()}
                />,
            );
        });

        expect(renderer.root.findByProps({ testID: 'session-composer-model-trigger' }).props.accessibilityHint).toBe('Not available');
        expect(renderer.root.findAllByProps({ testID: 'session-composer-effort-trigger' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'session-composer-disabled-reason' }).props.children)
            .toBe('Not available');

        act(() => renderer.unmount());
    });

    it('keeps the full picker affordance for desktop composers', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={modelOptions[1]}
                    modelOptions={modelOptions}
                    effort={effortOptions[1]}
                    effortOptions={effortOptions}
                    onModelChange={vi.fn()}
                    onEffortChange={vi.fn()}
                />,
            );
        });

        const selector = renderer.root.findByProps({ testID: 'session-composer-mode-selector' });
        expect(selector.props.style).toContainEqual({ maxWidth: 220 });
        expect(renderer.root.findAllByType('Ionicons')).toHaveLength(2);

        act(() => renderer.unmount());
    });
});
