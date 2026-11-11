import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRunningSessionTurnModes } from '@/utils/runningSessionTurnModes';
import { SessionComposerModeSelector, getModePanelPlacement } from './SessionComposerModeSelector';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    Modal: ({ visible, children }: any) => (visible ? children : null),
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
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
                    onModelChange={vi.fn()} onEffortChange={onEffortChange} supportsFast />,
            );
        });
        const trigger = () => renderer.root.findByProps({ testID: 'session-composer-mode-trigger' });
        const background = (pressed: boolean) => Object.assign({}, ...trigger().props.style({ pressed }).filter(Boolean)).backgroundColor;
        expect(background(false)).toBeUndefined();
        expect(background(true)).toBe('#333');
        act(() => trigger().props.onPress());
        expect(background(false)).toBe('#333');
        const reset = renderer.root.findByProps({ testID: 'session-composer-effort-reset' });
        expect(reset.props.accessibilityHint).toBe('default effort');
        act(() => reset.props.onPress());
        expect(onEffortChange).toHaveBeenCalledWith('default');
        expect(renderer.root.findAllByType('Text').some((node: any) =>
            ['default effort', 'agentInput.effort.fastOff'].includes(node.props.children),
        )).toBe(false);
        act(() => renderer.root.findByProps({ testID: 'session-composer-mode-picker-scrim' }).props.onPress());
        expect(background(false)).toBeUndefined();
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
