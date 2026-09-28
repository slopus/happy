import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const prefs = vi.hoisted(() => ({ reducedTransparency: false }));
const canvasTheme = vi.hoisted(() => ({ colors: { desktopSkin: {
    canvas: '#13171D', readingSolid: '#151A21', readingHidden: 'rgba(21,26,33,0.92)',
    readingCompact: 'rgba(21,26,33,0.70)', readingWide: 'rgba(21,26,33,0.51)',
} } }));
vi.mock('react-native', () => ({ ImageBackground: 'ImageBackground', View: 'View' }));
vi.mock('@/hooks/useReducedTransparency', () => ({ useReducedTransparency: () => prefs.reducedTransparency }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: canvasTheme }) }));
import { DesktopSkinCanvas } from './DesktopSkinCanvas.web';
import { WARM_NIGHT_BACKGROUND_URL } from '@/desktopSkin';

describe('DesktopSkinCanvas', () => {
    it('keeps the home photograph when a right panel narrows the main pane', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas skin="dreamskin" />); });
        const canvas = renderer.root.findByProps({ testID: 'dreamskin-photo-canvas' });
        act(() => canvas.props.onLayout({ nativeEvent: { layout: { width: 760 } } }));
        expect(renderer.root.findAllByProps({ testID: 'dreamskin-photo' })).toHaveLength(1);
        act(() => renderer.unmount());
    });
    it('uses a translucent reading surface without duplicating the workspace photograph', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas skin="dreamskin" reading photo={false} />); });
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
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas skin="dreamskin" reading photo={false} readingWidth={1120} />); });
        expect(renderer.root.findByProps({ testID: 'dreamskin-reading-surface' }).props.style.maxWidth).toBe(1370);
        act(() => renderer.unmount());
    });
    it('uses solid surfaces when the user requests reduced transparency', () => {
        prefs.reducedTransparency = true;
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas skin="dreamskin" reading />); });
        expect(renderer.root.findAllByProps({ testID: 'dreamskin-photo' })).toHaveLength(0);
        expect(renderer.root.findByProps({ testID: 'dreamskin-reading-surface' }).props.style.backgroundColor).toBe('#151A21');
        act(() => renderer.unmount());
        prefs.reducedTransparency = false;
    });
    it('uses the new photograph and warmer reading surface for the second skin', () => {
        canvasTheme.colors.desktopSkin = {
            canvas: '#17151A', readingSolid: '#221F24', readingHidden: 'rgba(34,31,36,0.94)',
            readingCompact: 'rgba(34,31,36,0.78)', readingWide: 'rgba(34,31,36,0.62)',
        };
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<DesktopSkinCanvas skin="warmNight" reading />); });
        const canvas = renderer.root.findByProps({ testID: 'dreamskin-photo-canvas' });
        act(() => canvas.props.onLayout({ nativeEvent: { layout: { width: 1200 } } }));
        expect(renderer.root.findByProps({ testID: 'dreamskin-photo' }).props.source.uri).toBe(WARM_NIGHT_BACKGROUND_URL);
        expect(renderer.root.findByProps({ testID: 'dreamskin-reading-surface' }).props.style.backgroundColor).toBe('rgba(34,31,36,0.62)');
        act(() => renderer.unmount());
        canvasTheme.colors.desktopSkin = {
            canvas: '#13171D', readingSolid: '#151A21', readingHidden: 'rgba(21,26,33,0.92)',
            readingCompact: 'rgba(21,26,33,0.70)', readingWide: 'rgba(21,26,33,0.51)',
        };
    });
});
