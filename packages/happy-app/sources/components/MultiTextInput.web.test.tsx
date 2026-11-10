import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// react-test-renderer 没有随包发布 TypeScript 声明。
// @ts-expect-error 测试只使用 create/unmount 所需的最小接口。
import TestRenderer from 'react-test-renderer';

import { MultiTextInput } from './MultiTextInput.web';

vi.mock('react-native', () => ({
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { text: '#ffffff' },
            },
        },
    }),
}));
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({ fontFamily: 'Test Mono' }),
    },
}));
vi.mock('react-textarea-autosize', () => ({
    default: 'TextareaAutosize',
}));

describe('MultiTextInput Web 可访问属性', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('把稳定名称和测试标识转发给真实 textarea', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <MultiTextInput
                    value=""
                    accessibilityLabel="基础用法"
                    testID="dev-multi-text-input-basic"
                />,
            );
        });

        const textarea = renderer.root.findByType('TextareaAutosize');
        expect(textarea.props['aria-label']).toBe('基础用法');
        expect(textarea.props['data-testid']).toBe('dev-multi-text-input-basic');

        act(() => renderer.unmount());
    });

    it('invalidates ghost suggestions at composition and paste start without intercepting IME confirmation', () => {
        const onActivity = vi.fn();
        const onKeyPress = vi.fn(() => true);
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<MultiTextInput defaultValue="" onInputActivity={onActivity} onKeyPress={onKeyPress} />); });
        const textarea = renderer.root.findByType('TextareaAutosize');
        const preventDefault = vi.fn();
        act(() => {
            textarea.props.onCompositionStart();
            textarea.props.onPasteCapture();
            textarea.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault });
        });
        expect(onActivity).toHaveBeenCalledTimes(2);
        expect(onKeyPress).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });
});
