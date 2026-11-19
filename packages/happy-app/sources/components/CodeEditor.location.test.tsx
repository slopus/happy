// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-simple-code-editor', () => ({ default: 'Editor' }));
import { CodeEditor } from './CodeEditor.web';
it('reveals the requested caret once without stealing it again on edits', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const input = { focus: vi.fn(), setSelectionRange: vi.fn() };
    const reveal = vi.fn(); const location = { line: 2, column: 3 };
    const props = { value: 'abc\nhello', onChange: vi.fn(), language: null, darkMode: false, location, onRevealLine: reveal, readOnly: true };
    let r: any;
    act(() => { r = TestRenderer.create(<CodeEditor {...props} />, { createNodeMock: (node: { type: unknown }) => node.type === 'div' ? { querySelector: (selector: string) => selector === 'textarea' ? input : null } : null }); });
    expect(input.setSelectionRange).toHaveBeenCalledWith(6, 6); expect(reveal).toHaveBeenCalled();
    expect(r.root.findByType('Editor').props.readOnly).toBe(true);
    act(() => r.update(<CodeEditor {...props} value={'abc\nchanged'} />)); expect(input.focus).toHaveBeenCalledTimes(1);
    act(() => r.update(<CodeEditor {...props} location={{ line: 2, column: null }} />));
    expect(input.setSelectionRange).toHaveBeenLastCalledWith(4, 9); expect(input.focus).toHaveBeenCalledTimes(2);
    act(() => r.unmount());
});

it('uses normalized textarea offsets for actual CRLF content', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const input = document.createElement('textarea'); input.value = 'abc\r\nhello';
    document.body.appendChild(input);
    let r: any; act(() => { r = TestRenderer.create(<CodeEditor value={'abc\r\nhello'} onChange={vi.fn()} language={null} darkMode={false} location={{ line: 2, column: 3 }} />, { createNodeMock: (node: { type: unknown }) => node.type === 'div' ? { querySelector: (selector: string) => selector === 'textarea' ? input : null } : null }); });
    expect(input.value).toBe('abc\nhello');
    expect(input.selectionStart).toBe(6); expect(input.selectionEnd).toBe(6);
    act(() => r.unmount()); input.remove();
});
