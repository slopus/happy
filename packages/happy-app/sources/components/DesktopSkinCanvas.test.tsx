import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const prefs = vi.hoisted(() => ({ reducedTransparency: false }));
vi.mock('react-native', () => ({ ImageBackground: 'ImageBackground', View: 'View' }));
vi.mock('@/hooks/useReducedTransparency', () => ({ useReducedTransparency: () => prefs.reducedTransparency }));
import { DesktopSkinCanvas } from './DesktopSkinCanvas.web';

describe('DesktopSkinCanvas', () => {
    it('keeps the home photograph when a right panel narrows the main pane', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas />); });
        const canvas = renderer.root.findByProps({ testID: 'dreamskin-photo-canvas' });
        act(() => canvas.props.onLayout({ nativeEvent: { layout: { width: 760 } } }));
        expect(renderer.root.findAllByProps({ testID: 'dreamskin-photo' })).toHaveLength(1);
        act(() => renderer.unmount());
    });
    it('uses a translucent reading surface without duplicating the workspace photograph', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas reading photo={false} />); });
        const canvas = renderer.root.findByProps({ testID: 'dreamskin-photo-canvas' });
        expect(renderer.root.findAllByProps({ testID: 'dreamskin-photo' })).toHaveLength(0);
        expect(renderer.root.findAll((node: any) => typeof node.props.style?.backgroundImage === 'string')).toHaveLength(0);
        act(() => canvas.props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
        expect(renderer.root.findAllByProps({ testID: 'dreamskin-photo' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'dreamskin-reading-surface' })).toHaveLength(1);
        expect(renderer.root.findByProps({ testID: 'dreamskin-reading-surface' }).props.style.backgroundColor).toBe('rgba(21,26,33,0.51)');
        act(() => canvas.props.onLayout({ nativeEvent: { layout: { width: 960 } } }));
        expect(renderer.root.findByProps({ testID: 'dreamskin-reading-surface' }).props.style.backgroundColor).toBe('rgba(21,26,33,0.70)');
        act(() => canvas.props.onLayout({ nativeEvent: { layout: { width: 760 } } }));
        expect(renderer.root.findByProps({ testID: 'dreamskin-reading-surface' }).props.style.backgroundColor).toBe('rgba(21,26,33,0.92)');
        expect(renderer.root.findAllByProps({ testID: 'dreamskin-photo' })).toHaveLength(0);
        act(() => renderer.unmount());
    });
    it('expands the reading surface with the chosen transcript width', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas reading photo={false} readingWidth={1120} />); });
        expect(renderer.root.findByProps({ testID: 'dreamskin-reading-surface' }).props.style.maxWidth).toBe(1370);
        act(() => renderer.unmount());
    });
    it('uses solid surfaces when the user requests reduced transparency', () => {
        prefs.reducedTransparency = true;
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas reading />); });
        expect(renderer.root.findAllByProps({ testID: 'dreamskin-photo' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'dreamskin-reading-surface' }).props.style.backgroundColor).toBe('#151A21');
        act(() => renderer.unmount());
        prefs.reducedTransparency = false;
    });
});
