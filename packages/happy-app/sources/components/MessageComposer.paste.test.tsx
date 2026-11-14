vi.mock('./ComposerContextPicker', () => ({ ComposerContextPicker: 'ComposerContextPicker' }));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path', Rect: 'Rect', Circle: 'Circle' }));
// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Platform } from 'react-native';
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
        MULTI_TEXT_INPUT_FONT_SIZE: 16,
        MULTI_TEXT_INPUT_LINE_HEIGHT: 22,
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
            input: { background: '#111', text: '#fff', placeholder: '#999' },
            radio: { active: '#f90' },
            shadow: { color: '#000', opacity: 0.2 },
            success: '#0f0',
            surface: '#111',
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

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/normalizeImageForUpload', () => ({ normalizeImageForUpload: async (uri: string, width: number, height: number) => ({ uri, width, height, size: 5, mimeType: 'image/png' }) }));
vi.mock('@/utils/thumbhash', () => ({ generateThumbhash: async () => undefined }));

import { MessageComposer } from './MessageComposer';

describe('MessageComposer web image paste', () => {
    const renderers: any[] = [];

    beforeEach(async () => {
        Platform.OS = 'web';
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
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
        container.getClientRects = () => [new DOMRect(0, 0, 100, 100)] as any;
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

    it('shows one overlay and handles a drop once with two mounted composers', async () => {
        const added: unknown[] = [];
        const addImages = (images: unknown[]) => added.push(...images);
        mountComposer(addImages as any);
        mountComposer(addImages as any);
        const file = new File(['image'], 'chart.png', { type: 'image/png' });
        const drag = new Event('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(drag, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
        document.dispatchEvent(drag);
        expect(drag.defaultPrevented).toBe(true);
        expect(document.querySelectorAll('[data-testid="file-drop-overlay"]')).toHaveLength(1);
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
        await act(async () => { document.dispatchEvent(drop); await vi.dynamicImportSettled(); });
        expect(document.querySelector('[data-testid="file-drop-overlay"]')).toBeNull();
        expect(added).toHaveLength(1);
    });

    it('keeps every file from a mixed multi-file drop in one batch', async () => {
        const composer = mountComposer();
        const files = [new File(['image'], 'first.png', { type: 'image/png' }),
            new File(['image'], 'second.png', { type: 'image/png' }),
            new File(['document'], 'third.txt', { type: 'text/plain' })];
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files } });
        await act(async () => { document.dispatchEvent(drop); await vi.dynamicImportSettled(); });
        expect(composer.onAddImages).toHaveBeenCalledTimes(1);
        expect(composer.onAddImages.mock.calls[0][0].map((item: any) => item.name)).toEqual(['first.png', 'second.png', 'third.txt']);
    });

    it('does not let an inert old composer consume a file drop', async () => {
        const old = mountComposer();
        old.input.parentElement!.setAttribute('inert', '');
        const active = mountComposer();
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] } });
        await act(async () => { document.dispatchEvent(drop); await vi.dynamicImportSettled(); });
        expect(old.onAddImages).not.toHaveBeenCalled();
        expect(active.onAddImages).toHaveBeenCalledWith([expect.objectContaining({ name: 'notes.txt', kind: 'file' })]);
    });

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

    it('keeps prediction out of the live draft and only fills it on explicit Tab acceptance', () => {
        const ref = React.createRef<any>();
        const onSend = vi.fn();
        const onQueue = vi.fn();
        const onChange = vi.fn();
        const onDismiss = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageComposer ref={ref} mode="session" initialValue="" placeholder="Message"
                onSend={onSend} onQueue={onQueue} onChangeText={onChange}
                predictionText="Show me the preview." onDismissPrediction={onDismiss} />);
            renderers.push(renderer);
        });
        expect(ref.current.getText()).toBe('');
        expect(onChange).not.toHaveBeenCalled();
        const input = renderer.root.findByType('MultiTextInput');
        let handled: boolean | undefined;
        act(() => { handled = input.props.onKeyPress({ key: 'Tab', shiftKey: true }); });
        expect(handled).toBe(false);
        expect(ref.current.getText()).toBe('');
        act(() => { input.props.onKeyPress({ key: 'Enter', shiftKey: false }); });
        expect(onSend).not.toHaveBeenCalled();
        act(() => { handled = input.props.onKeyPress({ key: 'Tab', shiftKey: false }); });
        expect(handled).toBe(true);
        expect(ref.current.getText()).toBe('Show me the preview.');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('Show me the preview.');
        expect(onQueue).not.toHaveBeenCalled();
        expect(onSend).not.toHaveBeenCalled();
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('shows only subdued ghost text, restores it after deletion and keeps Escape dismissal', () => {
        const ref = React.createRef<any>();
        const onDismiss = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageComposer ref={ref} mode="session" initialValue="" placeholder="Message"
                onSend={vi.fn()} predictionText="Suggested reply" onDismissPrediction={onDismiss} />);
            renderers.push(renderer);
        });
        const ghost = () => renderer.root.findByProps({ testID: 'composer-prediction-text' });
        expect(ghost().props.style).toMatchObject({ color: '#999', opacity: 0.65, fontSize: 16, lineHeight: 22 });
        expect(ghost().props.numberOfLines).toBeUndefined();
        expect(ghost().props.style.position).toBeUndefined();
        expect(ghost().props.style.flex).toBe(1);
        expect(renderer.root.findAllByProps({ testID: 'composer-prediction-accept' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'composer-prediction-dismiss' })).toHaveLength(0);
        const input = () => renderer.root.findByType('MultiTextInput');
        act(() => input().props.onKeyPress({ key: 'Tab', shiftKey: false }));
        expect(ref.current.getText()).toBe('Suggested reply');
        expect(renderer.root.findAllByProps({ testID: 'composer-prediction-text' })).toHaveLength(0);
        act(() => ref.current.setTextAndSelection('', { start: 0, end: 0 }));
        expect(ghost().props.children).toBe('Suggested reply');
        act(() => input().props.onKeyPress({ key: 'Escape', shiftKey: false }));
        expect(onDismiss).toHaveBeenCalledOnce();
        act(() => ref.current.setTextAndSelection('My own reply', { start: 12, end: 12 }));
        expect(renderer.root.findAllByProps({ testID: 'composer-prediction-text' })).toHaveLength(0);
        expect(ref.current.getText()).toBe('My own reply');
    });

    it('wraps a complete multi-sentence suggestion in layout and accepts every constraint', () => {
        const text = '先做 B，结合上下文告诉我谁找我、什么事、需要我做什么，AI 失败也要正常提醒。先把目标和任务拆分对齐，暂时不要直接写代码。';
        const ref = React.createRef<any>();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageComposer ref={ref} mode="session" initialValue="" placeholder="Message"
                onSend={vi.fn()} predictionText={text} />);
            renderers.push(renderer);
        });
        const ghost = renderer.root.findByProps({ testID: 'composer-prediction-text' });
        expect(ghost.props.children).toBe(text);
        expect(ghost.props.numberOfLines).toBeUndefined();
        expect(ghost.props.style.position).toBeUndefined(); // Natural height keeps the toolbar below all lines.
        const input = renderer.root.findByType('MultiTextInput');
        let editor = input.parent;
        while (editor && editor.type !== 'View') editor = editor.parent;
        expect(editor.props.style).toMatchObject({ position: 'absolute' });
        act(() => ghost.props.onPress()); // Web click only focuses; it does not accept.
        expect(ref.current.getText()).toBe('');
        act(() => input.props.onKeyPress({ key: 'Tab', shiftKey: false }));
        expect(ref.current.getText()).toBe(text);
    });

    it('accepts native ghost text by tapping the text itself without extra controls or sending', () => {
        Platform.OS = 'android';
        const ref = React.createRef<any>();
        const onSend = vi.fn();
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageComposer ref={ref} mode="session" initialValue="" placeholder="Message"
                onSend={onSend} predictionText="Suggested reply" />);
            renderers.push(renderer);
        });
        act(() => renderer.root.findByProps({ testID: 'composer-prediction-text' }).props.onPress());
        expect(ref.current.getText()).toBe('Suggested reply');
        expect(onSend).not.toHaveBeenCalled();
    });

    it('hides predictions when contextual content is pending', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageComposer mode="session" initialValue="" placeholder="Message"
                onSend={vi.fn()} predictionText="Suggested reply" hasContext />);
            renderers.push(renderer);
        });
        expect(renderer.root.findAllByProps({ testID: 'composer-prediction-text' })).toHaveLength(0);
    });

    it('dismisses prediction and opens the context menu before choosing an attachment', () => {
        const actions: string[] = [];
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<MessageComposer mode="session" initialValue="" placeholder="Message"
                onSend={vi.fn()} predictionText="Suggested reply"
                onDismissPrediction={() => actions.push('dismiss')}
                onPickImages={() => actions.push('pick')} />);
            renderers.push(renderer);
        });
        const picker = renderer.root.findAllByType('Pressable').find((node: any) => node.props.testID === 'composer-context-trigger');
        act(() => picker.props.onPress());
        expect(actions).toEqual(['dismiss']);
        const menu = renderer.root.findByType('ComposerContextPicker');
        act(() => menu.props.onPickFiles());
        expect(actions).toEqual(['dismiss', 'pick']);
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
