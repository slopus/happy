import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { platform, setTextAndSelection, setSelection } = vi.hoisted(() => ({
    platform: { OS: 'ios' as 'ios' | 'android' },
    setTextAndSelection: vi.fn(),
    setSelection: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    // Stands in for the native view: the ref is what commands are sent to.
    const TextInput = ReactModule.forwardRef((props: any, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({ focus: vi.fn(), blur: vi.fn(), setSelection }), []);
        return ReactModule.createElement('TextInput', props);
    });
    return {
        Platform: platform,
        Text: host('Text'),
        TextInput,
        View: host('View'),
        codegenNativeCommands: () => ({ setTextAndSelection }),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { input: { text: '#000', placeholder: '#999' } } } }),
}));

import { MultiTextInput, type MultiTextInputHandle } from './MultiTextInput';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
    setTextAndSelection.mockClear();
    setSelection.mockClear();
});

function render(element: React.ReactElement): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = create(element);
    });
    return renderer;
}

function field(renderer: ReactTestRenderer) {
    return renderer.root.findByType('TextInput' as any);
}

describe('MultiTextInput on iOS: the native field owns its text', () => {
    beforeEach(() => {
        platform.OS = 'ios';
    });

    function type(renderer: ReactTestRenderer, text: string, eventCount: number) {
        act(() => {
            field(renderer).props.onChange({ nativeEvent: { text, eventCount } });
        });
    }

    it('never hands the native field a value, so keystrokes write nothing back', () => {
        const onChangeText = vi.fn();
        const renderer = render(React.createElement(MultiTextInput, { defaultValue: 'draft', onChangeText }));

        expect(field(renderer).props.value).toBeUndefined();
        expect(field(renderer).props.defaultValue).toBe('draft');

        type(renderer, 'draft one', 1);
        type(renderer, 'draft one two', 2);

        expect(onChangeText).toHaveBeenLastCalledWith('draft one two');
        expect(field(renderer).props.value).toBeUndefined();
        expect(field(renderer).props.defaultValue).toBe('draft');
        expect(setTextAndSelection).not.toHaveBeenCalled();
    });

    it('writes imperative text through the native command at the latest edit count', () => {
        const ref = React.createRef<MultiTextInputHandle>();
        const onChangeText = vi.fn();
        const renderer = render(React.createElement(MultiTextInput, { ref, defaultValue: '', onChangeText }));
        type(renderer, 'hello @fo', 9);

        act(() => ref.current!.setTextAndSelection('hello @foo ', { start: 11, end: 11 }));

        expect(setTextAndSelection).toHaveBeenCalledTimes(1);
        expect(setTextAndSelection.mock.calls[0].slice(1)).toEqual([9, 'hello @foo ', 11, 11]);
        expect(ref.current!.getText()).toBe('hello @foo ');
        expect(onChangeText).toHaveBeenLastCalledWith('hello @foo ');
    });

    it('writes a controlled value only when the parent changes it', () => {
        const renderer = render(React.createElement(MultiTextInput, { value: 'a', onChangeText: () => {} }));

        type(renderer, 'ab', 1);
        act(() => renderer.update(React.createElement(MultiTextInput, { value: 'ab', onChangeText: () => {} })));
        expect(setTextAndSelection).not.toHaveBeenCalled();
        expect(field(renderer).props.value).toBeUndefined();

        act(() => renderer.update(React.createElement(MultiTextInput, { value: '', onChangeText: () => {} })));
        expect(setTextAndSelection).toHaveBeenCalledTimes(1);
        expect(setTextAndSelection.mock.calls[0].slice(1)).toEqual([1, '', -1, -1]);
    });

    it('carries typed text across a read-only spell into a fresh native field', () => {
        const ref = React.createRef<MultiTextInputHandle>();
        const element = (editable: boolean) => React.createElement(MultiTextInput, { ref, defaultValue: '', editable });
        const renderer = render(element(true));
        type(renderer, 'typed', 5);

        act(() => renderer.update(element(false)));
        expect(renderer.root.findByType('Text' as any).props.children).toBe('typed');

        act(() => ref.current!.setTextAndSelection('restored', { start: 8, end: 8 }));
        expect(renderer.root.findByType('Text' as any).props.children).toBe('restored');

        act(() => renderer.update(element(true)));
        expect(field(renderer).props.defaultValue).toBe('restored');

        act(() => ref.current!.setTextAndSelection('', { start: 0, end: 0 }));
        expect(setTextAndSelection.mock.calls[0].slice(1)).toEqual([0, '', 0, 0]);
    });
});

describe('MultiTextInput on Android: the field is bound to value', () => {
    beforeEach(() => {
        platform.OS = 'android';
    });

    function type(renderer: ReactTestRenderer, text: string) {
        act(() => {
            field(renderer).props.onChangeText(text);
        });
    }

    it('binds keystrokes to value without the native command', () => {
        const onChangeText = vi.fn();
        const renderer = render(React.createElement(MultiTextInput, { defaultValue: 'draft', onChangeText }));
        expect(field(renderer).props.value).toBe('draft');

        type(renderer, 'draft one');

        expect(field(renderer).props.value).toBe('draft one');
        expect(onChangeText).toHaveBeenLastCalledWith('draft one');
        expect(setTextAndSelection).not.toHaveBeenCalled();
    });

    it('writes imperative text through value and then places the caret', () => {
        const ref = React.createRef<MultiTextInputHandle>();
        const onChangeText = vi.fn();
        const renderer = render(React.createElement(MultiTextInput, { ref, defaultValue: '', onChangeText }));
        type(renderer, 'hello @fo');

        act(() => ref.current!.setTextAndSelection('hello @foo ', { start: 11, end: 11 }));

        expect(field(renderer).props.value).toBe('hello @foo ');
        expect(setSelection).toHaveBeenCalledWith(11, 11);
        expect(ref.current!.getText()).toBe('hello @foo ');
        expect(onChangeText).toHaveBeenLastCalledWith('hello @foo ');
        expect(setTextAndSelection).not.toHaveBeenCalled();
    });

    it('applies the caret even when the text is unchanged', () => {
        const ref = React.createRef<MultiTextInputHandle>();
        render(React.createElement(MultiTextInput, { ref, defaultValue: 'abc' }));

        act(() => ref.current!.setTextAndSelection('abc', { start: 1, end: 1 }));

        expect(setSelection).toHaveBeenCalledWith(1, 1);
    });

    it('passes a controlled value straight through', () => {
        const renderer = render(React.createElement(MultiTextInput, { value: 'a', onChangeText: () => {} }));
        expect(field(renderer).props.value).toBe('a');

        act(() => renderer.update(React.createElement(MultiTextInput, { value: '', onChangeText: () => {} })));
        expect(field(renderer).props.value).toBe('');
        expect(setTextAndSelection).not.toHaveBeenCalled();
    });

    it('carries typed text across a read-only spell into a fresh field', () => {
        const ref = React.createRef<MultiTextInputHandle>();
        const element = (editable: boolean) => React.createElement(MultiTextInput, { ref, defaultValue: '', editable });
        const renderer = render(element(true));
        type(renderer, 'typed');

        act(() => renderer.update(element(false)));
        expect(renderer.root.findByType('Text' as any).props.children).toBe('typed');

        act(() => renderer.update(element(true)));
        expect(field(renderer).props.value).toBe('typed');
    });
});
