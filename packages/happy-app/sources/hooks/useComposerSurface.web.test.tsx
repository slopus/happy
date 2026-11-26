// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import Color from 'color';
import { appThemes } from '@/themePacks';
import { useComposerSurface } from './useComposerSurface.web';
import { useComposerSurface as useNativeComposerSurface } from './useComposerSurface';

vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (values: any) => values.web ?? values.default } }));

afterEach(() => { vi.unstubAllGlobals(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

it('uses the active theme and switches to an opaque surface when reduced transparency changes', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const listeners = new Set<() => void>();
    let reduced = false;
    const media = { get matches() { return reduced; }, addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    vi.stubGlobal('CSS', { supports: () => true });
    function Probe({ name }: { name: 'ginghamDark' | 'caramelLight' }) {
        const theme = appThemes[name];
        return <output data-style={useComposerSurface(theme.colors.input.background, theme.colors.divider, true, theme.dark)} />;
    }
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<Probe name="ginghamDark" />); });
    const style = () => renderer.root.findByType('output').props['data-style'];
    expect(Color(style().backgroundColor).alpha()).toBeLessThan(1);
    expect(Color(style().backgroundColor).alpha()).toBeGreaterThan(0.7);
    expect(Color(style().backgroundColor).hex()).toBe(Color(appThemes.ginghamDark.colors.input.background).hex());
    expect(style().borderColor).toBe(appThemes.ginghamDark.colors.divider);
    expect(style().backdropFilter).toContain('blur(');
    expect(style().opacity).toBeUndefined();
    act(() => { reduced = true; listeners.forEach(listener => listener()); });
    expect(style().backgroundColor).toBe(appThemes.ginghamDark.colors.input.background);
    expect(style().backdropFilter).toBeUndefined();
    act(() => renderer.update(<Probe name="caramelLight" />));
    expect(style().backgroundColor).toBe(appThemes.caramelLight.colors.input.background);
    act(() => { reduced = false; listeners.forEach(listener => listener()); });
    expect(Color(style().backgroundColor).hex()).toBe(Color(appThemes.caramelLight.colors.input.background).hex());
    act(() => renderer.unmount());
    expect(listeners.size).toBe(0);
});

it.each([false, true])('keeps an opaque fallback without standard filter support (webkit=%s)', async webkit => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('CSS', { supports: (property: string) => webkit && property === '-webkit-backdrop-filter' });
    function Probe() { return <output data-style={useComposerSurface('rgb(18, 29, 36)', 'rgb(55, 66, 77)', true)} />; }
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<Probe />); });
    const style = renderer.root.findByType('output').props['data-style'];
    if (webkit) expect(style.WebkitBackdropFilter).toContain('blur(');
    else { expect(style.backgroundColor).toBe('rgb(18, 29, 36)'); expect(style.backdropFilter).toBeUndefined(); }
    act(() => renderer.unmount());
});

it('leaves native surfaces untouched', () => {
    expect(useNativeComposerSurface('native background', 'native border', true)).toBeUndefined();
});

it('leaves the home composer untouched', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('CSS', { supports: () => true });
    function Probe() { return <output data-style={useComposerSurface('rgb(18, 29, 36)', 'rgb(55, 66, 77)', false)} />; }
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<Probe />); });
    expect(renderer.root.findByType('output').props['data-style']).toBeUndefined();
    act(() => renderer.unmount());
});
