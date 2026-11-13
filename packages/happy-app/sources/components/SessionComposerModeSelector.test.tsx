import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { resolveRunningSessionTurnModes } from '@/utils/runningSessionTurnModes';
import { SessionComposerModeSelector, getModePanelPlacement, formatComposerModelName } from './SessionComposerModeSelector';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Animated: { Value: class { setValue() {} interpolate() { return 1; } }, View: 'AnimatedView', loop: () => ({ start() {}, stop() {} }), sequence: () => ({}), timing: () => ({}) },
    Easing: { linear: () => ({}) },
    Platform: { OS: 'web' },
    Modal: ({ visible, children }: any) => (visible ? children : null),
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('@/components/SessionConfigPanel', () => ({ PickerContent: 'PickerContent' }));
vi.mock('@/text', () => ({
    t: (key: string) =>
        (
            ({
                'agentInput.model.title': 'MODEL',
                'agentInput.effort.title': 'EFFORT',
                'newSession.machineOffline': 'offline',
                'settingsAccount.notAvailable': 'Not available',
            }) as Record<string, string>
        )[key] ?? key,
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) =>
            typeof factory === 'function'
                ? (factory as (theme: any) => object)({
                      colors: {
                          switch: { thumb: { active: '#fff' } },
                          slider: { track: '#555' },
                          surfaceSelected: '#333',
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
        Platform.OS = 'web';
        consoleErrorSpy.mockRestore();
    });

    it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'])(
        'offers %s from the current session catalog',
        (model) => {
            const modes = resolveRunningSessionTurnModes({
                session: {
                    modelMode: null,
                    effortLevel: null,
                    metadata: {
                        flavor: 'codex',
                        currentModelCode: 'gpt-6-astra',
                        models: [{ code: 'gpt-6-astra', value: 'gpt-6-astra' }],
                    },
                } as any,
                agentDefaultOverrides: {},
                translate: (key) => key,
            });
            const onModelChange = vi.fn();
            let renderer: any;
            act(() => {
                renderer = TestRenderer.create(
                    <SessionComposerModeSelector
                        online
                        model={modes.modelMode}
                        modelOptions={modes.availableModels}
                        effort={modes.effortLevel}
                        effortOptions={modes.availableEffortLevels}
                        onModelChange={onModelChange}
                        onEffortChange={vi.fn()}
                    />,
                );
            });
            act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
            act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
            act(() =>
                renderer.root.findByProps({ testID: `session-composer-model-${model}` }).props.onPress(),
            );
            expect(onModelChange).toHaveBeenCalledWith(model);
            act(() => renderer.unmount());
        },
    );

    it('opens one panel for model, effort and fast settings', () => {
        const onModelChange = vi.fn(),
            onEffortChange = vi.fn(),
            onFastModeChange = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={modelOptions[0]}
                    modelOptions={modelOptions}
                    effort={effortOptions[0]}
                    effortOptions={effortOptions}
                    supportsFast
                    fastMode={false}
                    onModelChange={onModelChange}
                    onEffortChange={onEffortChange}
                    onFastModeChange={onFastModeChange}
                />,
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'session-composer-mode-panel' })).toBeTruthy();
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        act(() =>
            renderer.root.findByProps({ testID: 'session-composer-model-gpt-5.6-sol' }).props.onPress(),
        );
        expect(onModelChange).toHaveBeenCalledWith('gpt-5.6-sol');
        act(() => renderer.root.findByProps({ testID: 'session-composer-effort-xhigh' }).props.onPress());
        expect(onEffortChange).toHaveBeenCalledWith('xhigh');
        act(() => renderer.root.findByProps({ testID: 'session-composer-fast-toggle' }).props.onPress());
        expect(onFastModeChange).toHaveBeenCalledWith(true);
        act(() =>
            renderer.root.findByProps({ testID: 'session-composer-mode-picker-scrim' }).props.onPress(),
        );
        expect(renderer.root.findAllByProps({ testID: 'session-composer-mode-panel' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('keeps reset in the header without footer text and highlights only the open trigger', () => {
        const onEffortChange = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector online model={modelOptions[0]} modelOptions={modelOptions}
                    effort={effortOptions[0]} effortOptions={[{ key: 'default', name: 'default effort' }, ...effortOptions]}
                    onModelChange={vi.fn()} onEffortChange={onEffortChange} onReset={() => onEffortChange('medium')} supportsFast />,
            );
        });
        const trigger = () => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' });
        const background = (pressed: boolean) => Object.assign({}, ...trigger().props.style({ pressed }).filter(Boolean)).backgroundColor;
        expect(background(false)).toBeUndefined();
        expect(background(true)).toBe('#333');
        act(() => trigger().props.onPress());
        expect(background(false)).toBe('#333');
        const reset = renderer.root.findByProps({ testID: 'session-composer-effort-reset' });
        expect(reset.props.accessibilityHint).toBe('Medium');
        act(() => reset.props.onPress());
        expect(onEffortChange).toHaveBeenCalledWith('medium');
        expect(renderer.root.findAllByType('Text').some((node: any) =>
            ['default effort', 'agentInput.effort.fastOff'].includes(node.props.children),
        )).toBe(false);
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-picker-scrim' }).props.onPress());
        expect(background(false)).toBeUndefined();
        act(() => renderer.unmount());
    });

    it('resets model, effort and Fast together', () => {
        const onModelChange = vi.fn(), onEffortChange = vi.fn(), onFastModeChange = vi.fn();
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionComposerModeSelector online unifiedCodex
            model={{ key: 'gpt-6-astra', name: 'gpt-6-astra' }}
            modelOptions={[{ key: 'gpt-6-astra', name: 'gpt-6-astra' }, { key: 'gpt-6.1-sol', name: 'gpt-6.1-sol' }]}
            effort={{ key: 'high', name: 'high' }} effortOptions={effortOptions}
            fastMode supportsFast onModelChange={onModelChange} onEffortChange={onEffortChange} onFastModeChange={onFastModeChange} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-effort-reset' }).props.onPress());
        expect(onModelChange).toHaveBeenCalledWith('gpt-6.1-sol');
        expect(onEffortChange).toHaveBeenCalledWith('medium');
        expect(onFastModeChange).toHaveBeenCalledWith(false);
        act(() => renderer.unmount());
    });

    it('allows the supplied reset without effort options and disables it when the default model is unavailable', () => {
        const onReset = vi.fn(); let renderer: any;
        const props = { online: true, model: modelOptions[0], modelOptions, effort: null, effortOptions: [], onModelChange: vi.fn(), onEffortChange: vi.fn() };
        act(() => { renderer = TestRenderer.create(<SessionComposerModeSelector {...props} onReset={onReset} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const reset = () => renderer.root.findByProps({ testID: 'session-composer-effort-reset' });
        expect(reset().props.disabled).toBe(false);
        act(() => reset().props.onPress()); expect(onReset).toHaveBeenCalledOnce();
        act(() => renderer.update(<SessionComposerModeSelector {...props} />));
        expect(reset().props.disabled).toBe(true);
        act(() => renderer.unmount());
    });

    it('creates full-width moving particles on the first opening before track measurement', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionComposerModeSelector online model={modelOptions[0]} modelOptions={modelOptions}
            effort={effortOptions[1]} effortOptions={effortOptions} onModelChange={vi.fn()} onEffortChange={vi.fn()} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const particle = renderer.root.findByProps({ 'data-effort-particle': 0 });
        expect(particle.props.style.width).toBe('100%');
        expect(particle.props.style.animation).toContain('paws-effort-star');
        expect(particle.props.style.opacity).toBeGreaterThan(0);
        act(() => renderer.unmount());
    });

    it('disables the unified control offline and closes an open panel', () => {
        const props = {
            model: modelOptions[0],
            modelOptions,
            effort: effortOptions[0],
            effortOptions,
            onModelChange: vi.fn(),
            onEffortChange: vi.fn(),
        };
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<SessionComposerModeSelector {...props} online />);
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.update(<SessionComposerModeSelector {...props} online={false} />));
        const trigger = renderer.root.findByProps({ testID: 'session-composer-mode-trigger' });
        expect(trigger.props.disabled).toBe(true);
        expect(trigger.props.accessibilityHint).toBe('offline');
        expect(renderer.root.findAllByProps({ testID: 'session-composer-mode-panel' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('renders empty, black and Ultra gradient tracks for the reference states', () => {
        const levels = [
            { key: 'low', name: '轻度' },
            { key: 'max', name: 'Max' },
            { key: 'ultra', name: 'Ultra' },
        ];
        const props = { online: true, model: modelOptions[0], modelOptions,
            effortOptions: levels, onModelChange: vi.fn(), onEffortChange: vi.fn() };
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionComposerModeSelector {...props} effort={levels[0]} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        expect(renderer.root.findAllByType('AnimatedView')).toHaveLength(0);
        expect(renderer.root.findAllByType('LinearGradient')).toHaveLength(0);
        act(() => renderer.update(<SessionComposerModeSelector {...props} effort={levels[1]} />));
        expect(renderer.root.findAllByProps({ 'data-effort-particle': 0 })).toHaveLength(1);
        expect(renderer.root.findAllByType('LinearGradient')).toHaveLength(0);
        act(() => renderer.update(<SessionComposerModeSelector {...props} effort={levels[2]} />));
        expect(renderer.root.findAllByType('LinearGradient')).toHaveLength(1);
        expect(renderer.root.findAllByProps({ 'data-effort-particle': 21 })).toHaveLength(1);
        act(() => renderer.unmount());
    });

    it('keeps Fast visible when Codex does not advertise support and uses effort keys as labels', () => {
        const levels = [{ key: 'medium', name: '中' }, { key: 'high', name: '高' }];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<SessionComposerModeSelector online unifiedCodex
            model={modelOptions[0]} modelOptions={modelOptions} effort={levels[0]} effortOptions={levels}
            onModelChange={vi.fn()} onEffortChange={vi.fn()} onFastModeChange={vi.fn()} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        expect(renderer.root.findByProps({ testID: 'session-composer-fast-toggle' }).props.disabled).toBe(true);
        expect(renderer.root.findByProps({ testID: 'session-composer-effort-high' }).props.accessibilityLabel).toBe('High');
        expect(renderer.root.findByProps({ testID: 'session-composer-effort-medium' }).props.accessibilityLabel).toBe('Medium');
        act(() => renderer.unmount());
    });

    it('filters models by name or description and exposes the current selection', () => {
        let renderer: any;
        const models = [
            { key: 'a', name: 'Alpha', description: 'Reasoning model' },
            { key: 'b', name: 'Beta', description: 'Vision model' },
        ];
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={models[0]}
                    modelOptions={models}
                    effort={null}
                    effortOptions={[]}
                    onModelChange={vi.fn()}
                    onEffortChange={vi.fn()}
                />,
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => renderer.root.findByProps({ testID: 'session-composer-open-models' }).props.onPress());
        expect(
            renderer.root.findByProps({ testID: 'session-composer-model-a' }).props.accessibilityState
                .checked,
        ).toBe(true);
        act(() =>
            renderer.root
                .findByProps({ testID: 'session-composer-model-search' })
                .props.onChangeText('vision'),
        );
        expect(renderer.root.findAllByProps({ testID: 'session-composer-model-a' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'session-composer-model-b' })).toBeTruthy();
        act(() => renderer.unmount());
    });

    it('exposes checked semantics and supports Space on the Fast switch', () => {
        const onFastModeChange = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={modelOptions[0]}
                    modelOptions={modelOptions}
                    effort={effortOptions[0]}
                    effortOptions={effortOptions}
                    supportsFast
                    fastMode={false}
                    onFastModeChange={onFastModeChange}
                    onModelChange={vi.fn()}
                    onEffortChange={vi.fn()}
                />,
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const toggle = renderer.root.findByProps({ testID: 'session-composer-fast-toggle' });
        const preventDefault = vi.fn();
        expect(toggle.props['aria-checked']).toBe(false);
        act(() => toggle.props.onKeyDown({ key: ' ', repeat: false, preventDefault }));
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(onFastModeChange).toHaveBeenCalledWith(true);
        act(() => renderer.unmount());
    });

    it('previews a drag, commits only on release, and cancels without changing effort', () => {
        const onEffortChange = vi.fn();
        let renderer: any;
        const options = [{ key: 'default', name: 'default' }, ...effortOptions];
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={modelOptions[0]}
                    modelOptions={modelOptions}
                    effort={effortOptions[0]}
                    effortOptions={options}
                    onModelChange={vi.fn()}
                    onEffortChange={onEffortChange}
                />,
                { createNodeMock: () => ({ measureInWindow: (cb: any) => cb(100, 100, 200, 32) }) },
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const track = renderer.root.findByProps({ testID: 'session-composer-effort-track' });
        act(() => track.props.onLayout({ nativeEvent: { layout: { width: 200 } } }));
        const pointer = (clientX: number) => ({
            clientX,
            pointerId: 1,
            preventDefault: () => {},
            currentTarget: { setPointerCapture: () => {}, getBoundingClientRect: () => ({ left: 100 }) },
        });
        act(() => track.props.onPointerDown(pointer(116)));
        act(() => track.props.onPointerMove(pointer(284)));
        expect(onEffortChange).not.toHaveBeenCalled();
        act(() => track.props.onPointerCancel());
        expect(onEffortChange).not.toHaveBeenCalled();
        act(() => track.props.onPointerDown(pointer(284)));
        act(() => track.props.onPointerUp());
        expect(onEffortChange).toHaveBeenCalledOnce();
        expect(onEffortChange).toHaveBeenCalledWith('xhigh');
        expect(renderer.root.findAllByProps({ testID: 'session-composer-effort-default' })).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('keeps the dragged position continuous and the committed value while props catch up', () => {
        const onEffortChange = vi.fn();
        let renderer: any;
        const props = { online: true, model: modelOptions[0], modelOptions,
            effort: effortOptions[0], effortOptions, onModelChange: vi.fn(), onEffortChange };
        act(() => { renderer = TestRenderer.create(<SessionComposerModeSelector {...props} />); });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const track = renderer.root.findByProps({ testID: 'session-composer-effort-track' });
        act(() => track.props.onLayout({ nativeEvent: { layout: { width: 200 } } }));
        const pointer = (clientX: number) => ({ clientX, pointerId: 1, preventDefault: () => {},
            currentTarget: { setPointerCapture: () => {}, getBoundingClientRect: () => ({ left: 100 }) } });
        act(() => track.props.onPointerDown(pointer(116)));
        act(() => track.props.onPointerMove(pointer(140)));
        const knob = () => renderer.root.findByProps({ testID: 'session-composer-effort-knob' });
        expect(parseFloat(knob().props.style.at(-1).left)).toBeGreaterThan(0);
        expect(parseFloat(knob().props.style.at(-1).left)).toBeLessThan(50);
        act(() => track.props.onPointerMove(pointer(284)));
        act(() => track.props.onPointerUp());
        expect(onEffortChange).toHaveBeenCalledWith('xhigh');
        expect(knob().props.style.at(-1).left).toBe('100%');
        act(() => renderer.update(<SessionComposerModeSelector {...props} effort={effortOptions[1]} />));
        expect(knob().props.style.at(-1).left).toBe('100%');
        act(() => renderer.unmount());
    });

    it.each(['android', 'ios'] as const)('keeps %s dragging relative to the track when touch targets change', (platform) => {
        Platform.OS = platform;
        const onEffortChange = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online model={modelOptions[0]} modelOptions={modelOptions}
                    effort={effortOptions[0]} effortOptions={effortOptions}
                    onModelChange={vi.fn()} onEffortChange={onEffortChange}
                />,
                { createNodeMock: () => ({
                    measure: (cb: any) => cb(0, 0, 200, 32, 100, 300),
                }) },
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const track = renderer.root.findByProps({ testID: 'session-composer-effort-track' });
        act(() => track.props.onLayout({ nativeEvent: { layout: { width: 200 } } }));
        const touch = (pageX: number, locationX: number) => ({ nativeEvent: { pageX, locationX } });
        const position = () => parseFloat(renderer.root.findByProps({ testID: 'session-composer-effort-knob' }).props.style.at(-1).left);

        // locationX belongs to the hit child (step/knob), which can move beneath the finger.
        act(() => track.props.onResponderGrant(touch(200, 0)));
        expect(position()).toBeCloseTo(50);
        act(() => track.props.onResponderMove(touch(200, 200)));
        expect(position()).toBeCloseTo(50);
        act(() => track.props.onResponderMove(touch(242, 0)));
        expect(position()).toBeCloseTo(75);
        act(() => track.props.onResponderMove(touch(158, 200)));
        expect(position()).toBeCloseTo(25);
        expect(onEffortChange).not.toHaveBeenCalled();
        act(() => track.props.onResponderRelease(touch(284, 0)));
        expect(position()).toBe(100);
        expect(onEffortChange).toHaveBeenCalledExactlyOnceWith('xhigh');
        act(() => renderer.unmount());
    });

    it('uses the latest native touch while measurement is pending and commits a quick release once', () => {
        Platform.OS = 'android';
        const onEffortChange = vi.fn();
        let measure: any;
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online model={modelOptions[0]} modelOptions={modelOptions}
                    effort={effortOptions[0]} effortOptions={effortOptions}
                    onModelChange={vi.fn()} onEffortChange={onEffortChange}
                />,
                { createNodeMock: () => ({ measure: (cb: any) => { measure = cb; } }) },
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const track = renderer.root.findByProps({ testID: 'session-composer-effort-track' });
        act(() => track.props.onLayout({ nativeEvent: { layout: { width: 200 } } }));
        const touch = (pageX: number) => ({ nativeEvent: { pageX, locationX: 0 } });
        act(() => track.props.onResponderGrant(touch(116)));
        act(() => track.props.onResponderMove(touch(200)));
        act(() => track.props.onResponderRelease(touch(284)));
        expect(onEffortChange).not.toHaveBeenCalled();
        act(() => measure(0, 0, 200, 32, 100, 300));
        expect(onEffortChange).toHaveBeenCalledExactlyOnceWith('xhigh');
        act(() => renderer.unmount());
    });

    it.each(['terminate', 'close', 'model-change', 'unmount'])('ignores a late native measurement after %s', (cancel) => {
        Platform.OS = 'android';
        const onEffortChange = vi.fn();
        let measure: any;
        let renderer: any;
        const props = { online: true, model: modelOptions[0], modelOptions,
            effort: effortOptions[0], effortOptions, onModelChange: vi.fn(), onEffortChange };
        act(() => {
            renderer = TestRenderer.create(<SessionComposerModeSelector {...props} />,
                { createNodeMock: () => ({ measure: (cb: any) => { measure = cb; } }) });
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        const track = renderer.root.findByProps({ testID: 'session-composer-effort-track' });
        act(() => track.props.onLayout({ nativeEvent: { layout: { width: 200 } } }));
        const touch = { nativeEvent: { pageX: 284, locationX: 0 } };
        act(() => track.props.onResponderGrant(touch));
        act(() => track.props.onResponderRelease(touch));
        act(() => {
            if (cancel === 'terminate') track.props.onResponderTerminate();
            if (cancel === 'close') renderer.root.findByProps({ testID: 'session-composer-mode-picker-scrim' }).props.onPress();
            if (cancel === 'model-change') renderer.update(<SessionComposerModeSelector {...props} model={modelOptions[1]} />);
            if (cancel === 'unmount') renderer.unmount();
        });
        act(() => measure(0, 0, 200, 32, 100, 300));
        expect(onEffortChange).not.toHaveBeenCalled();
        if (cancel !== 'unmount') act(() => renderer.unmount());
    });

    it('formats known GPT model identifiers while preserving other provider names', () => {
        expect(formatComposerModelName('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
        expect(formatComposerModelName('GPT-6 ASTRA')).toBe('GPT-6 Astra');
        expect(formatComposerModelName('gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark');
        expect(formatComposerModelName('provider/custom-model')).toBe('provider/custom-model');
    });

    it('places the panel below an anchor near the top of a short viewport', () => {
        const placement = getModePanelPlacement(390, 700, { x: 200, y: 10, width: 100, height: 28 });
        expect(placement.top).toBe(46);
        expect(placement.maxHeight).toBeGreaterThan(200);
        expect(placement.left).toBeGreaterThanOrEqual(8);
        expect(placement.left + placement.width).toBeLessThanOrEqual(390);
    });

    it('dismisses an open panel when the web viewport changes', () => {
        const listeners: Record<string, EventListener> = {};
        vi.stubGlobal('window', {
            addEventListener: (name: string, fn: EventListener) => {
                listeners[name] = fn;
            },
            removeEventListener: (name: string) => {
                delete listeners[name];
            },
        });
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={modelOptions[0]}
                    modelOptions={modelOptions}
                    effort={effortOptions[0]}
                    effortOptions={effortOptions}
                    onModelChange={vi.fn()}
                    onEffortChange={vi.fn()}
                />,
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        act(() => listeners.resize(new Event('resize')));
        expect(renderer.root.findAllByProps({ testID: 'session-composer-mode-panel' })).toHaveLength(0);
        act(() => renderer.unmount());
        vi.unstubAllGlobals();
    });

    it('hides unsupported effort and fast controls', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionComposerModeSelector
                    online
                    model={modelOptions[0]}
                    modelOptions={modelOptions}
                    effort={null}
                    effortOptions={[]}
                    onModelChange={vi.fn()}
                    onEffortChange={vi.fn()}
                />,
            );
        });
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' }).props.onPress());
        expect(renderer.root.findAllByProps({ testID: 'session-composer-fast-toggle' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'session-composer-effort-xhigh' })).toHaveLength(0);
        act(() => renderer.unmount());
    });
});
