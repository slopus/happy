import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('./NativeComposerSelectorSheet', () => ({ NativeComposerSelectorSheet: 'NativeComposerSelectorSheet' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
import { ComposerContextHost } from './ComposerContextHost.android';
let renderer: any;
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });
it('hosts the Android Add panel in a separate native sheet and forwards dismissal', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const onClose = vi.fn();
    act(() => { renderer = TestRenderer.create(<ComposerContextHost fromButton anchorRef={{ current: null }} onClose={onClose}><span>Menu</span></ComposerContextHost>); });
    const sheet = renderer.root.findByType('NativeComposerSelectorSheet');
    expect(sheet.props.open).toBe(true);
    expect(sheet.findByType('span').children).toEqual(['Menu']);
    act(() => sheet.props.onClose());
    expect(onClose).toHaveBeenCalledOnce();
});
it('keeps the @ suggestions inline so typing retains the original input', () => {
    act(() => { renderer = TestRenderer.create(<ComposerContextHost fromButton={false} anchorRef={{ current: null }} onClose={vi.fn()}><span>Suggestions</span></ComposerContextHost>); });
    expect(renderer.root.findAllByType('NativeComposerSelectorSheet')).toHaveLength(0);
    expect(renderer.root.findByType('span').children).toEqual(['Suggestions']);
});
