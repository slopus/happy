// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const Modal = (props: any) => props.visible
        ? ReactModule.createElement('Modal', props, props.children)
        : null;

    return {
        ActivityIndicator: 'ActivityIndicator',
        Modal,
        Platform: {
            OS: 'web',
            select: (values: Record<string, unknown>) => values.web ?? values.default,
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
        MultiTextInput: ReactModule.forwardRef<any, any>((props, ref) => {
            const text = ReactModule.useRef(props.defaultValue ?? '');
            ReactModule.useImperativeHandle(ref, () => ({
                getText: () => text.current,
                setTextAndSelection: (value: string) => {
                    text.current = value;
                    props.onChangeText?.(value);
                },
                focus: vi.fn(),
                blur: vi.fn(),
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
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/desktopNavigationLayout', () => ({ supportsDesktopComposerModeSelector: () => false }));
vi.mock('./SessionComposerModeSelector', () => ({ SessionComposerModeSelector: 'SessionComposerModeSelector' }));
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

vi.mock('@/utils/thumbhash', () => ({ generateThumbhash: async () => undefined }));

import { MessageComposer } from './MessageComposer';

describe('MessageComposer web image paste', () => {
    const renderers: any[] = [];

    beforeEach(async () => {
        vi.stubGlobal('Image', class {
            naturalWidth = 100;
            naturalHeight = 100;
            onload?: () => void;
            set src(_uri: string) { this.onload?.(); }
        });
        vi.stubGlobal('URL', { createObjectURL: (file: File) => `blob:${file.name}` });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        act(() => renderers.splice(0).forEach(renderer => renderer.unmount()));
        document.body.replaceChildren();
        vi.unstubAllGlobals();
    });

    function mountComposer(onAddImages = vi.fn()) {
        const container = document.createElement('div');
        const input = document.createElement('textarea');
        container.append(input);
        document.body.append(container);
        act(() => {
            renderers.push(TestRenderer.create(
                <MessageComposer mode="home" initialValue="" placeholder="Message"
                    onSend={vi.fn()} onAddImages={onAddImages} />,
                { createNodeMock: (element: any) => element.props.testID === 'message-composer-content' ? container : null },
            ));
        });
        return { input, onAddImages };
    }

    function paste(input: HTMLTextAreaElement, names = ['image.png']) {
        input.focus();
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: {
            items: names.map(name => ({ kind: 'file', type: 'image/png',
                getAsFile: () => new File(['image'], name, { type: 'image/png' }) })),
        } });
        input.dispatchEvent(event);
        return event;
    }

    it('restores queue text through the current input callbacks after a composer update', () => {
        const ref = React.createRef<any>();
        const previousChange = vi.fn();
        const currentChange = vi.fn();
        const onSend = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageComposer ref={ref} mode="session"
                initialValue="" placeholder="Message" onSend={onSend} onChangeText={previousChange} />);
            renderers.push(renderer);
        });
        act(() => renderer.update(<MessageComposer ref={ref} mode="session"
            initialValue="" placeholder="Message" onSend={onSend} onChangeText={currentChange} />));
        act(() => ref.current.setTextAndSelection('Recovered queued message', { start: 24, end: 24 }));
        expect(ref.current.getText()).toBe('Recovered queued message');
        expect(currentChange).toHaveBeenCalledExactlyOnceWith('Recovered queued message');
        expect(previousChange).not.toHaveBeenCalled();
    });

    it('adds one image once when two mounted composers share a draft', async () => {
        const added: unknown[] = [];
        const addImages = (images: unknown[]) => added.push(...images);
        mountComposer(addImages as any);
        const active = mountComposer(addImages as any);
        await act(async () => { paste(active.input); await vi.dynamicImportSettled(); });
        expect(added).toHaveLength(1);
    });

    it('does not attach images pasted into an unrelated input', async () => {
        const composer = mountComposer();
        const other = document.createElement('textarea');
        document.body.append(other);
        await act(async () => { paste(other); await vi.dynamicImportSettled(); });
        expect(composer.onAddImages).not.toHaveBeenCalled();
    });

    it('prevents the image paste default synchronously', async () => {
        const composer = mountComposer();
        let prevented = false;
        await act(async () => { prevented = paste(composer.input).defaultPrevented; await vi.dynamicImportSettled(); });
        expect(prevented).toBe(true);
    });

    it('preserves multiple images and separate intentional pastes', async () => {
        const composer = mountComposer();
        await act(async () => { paste(composer.input, ['a.png', 'b.png']); await vi.dynamicImportSettled(); });
        await act(async () => { paste(composer.input, ['a.png']); await vi.dynamicImportSettled(); });
        expect(composer.onAddImages.mock.calls.map(([images]) => images.map((image: any) => image.name)))
            .toEqual([['a.png', 'b.png'], ['a.png']]);
    });

    it('leaves text-only paste to the input', async () => {
        const composer = mountComposer();
        let event: Event;
        await act(async () => { event = paste(composer.input, []); await vi.dynamicImportSettled(); });
        expect(event!.defaultPrevented).toBe(false);
        expect(composer.onAddImages).not.toHaveBeenCalled();
    });
});
