import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { GoalBoardButton } from './GoalBoardButton';
import { GoalBoardCard } from './GoalBoardCard';
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View', Platform: { OS: 'web' } }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: any) => factory({ colors: { surface: 'normal', surfacePressed: 'hover', surfaceSelected: 'selected', textLink: 'focus', divider: 'divider' } }) } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: any;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
const flatten = (value: any): any => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
it('lets the card own one uninterrupted background through normal, selected and hover states', () => {
    for (const selected of [false, true]) {
        act(() => { renderer = TestRenderer.create(<GoalBoardButton variant="card" label="Task" selected={selected} onPress={() => {}}>Task</GoalBoardButton>); });
        const button = renderer.root.findByType('Pressable');
        for (const state of [{ pressed: false }, { pressed: false, hovered: true }, { pressed: true }]) {
            expect(flatten(button.props.style(state)).backgroundColor).toBe('transparent');
        }
        act(() => renderer.unmount()); renderer = null;
    }
});
it('preserves semantic hover and selected surfaces on ordinary buttons', () => {
    act(() => { renderer = TestRenderer.create(<GoalBoardButton variant="row" label="Open" selected onPress={() => {}}>Open</GoalBoardButton>); });
    const button = renderer.root.findByType('Pressable');
    expect(flatten(button.props.style({ pressed: false })).backgroundColor).toBe('selected');
    expect(flatten(button.props.style({ pressed: true })).backgroundColor).toBe('hover');
});
it('puts keyboard and pointer focus on the outer card without a second inner border', () => {
    act(() => { renderer = TestRenderer.create(<GoalBoardCard testID="card"><GoalBoardButton variant="card" label="Task" onPress={() => {}}>Task</GoalBoardButton></GoalBoardCard>); });
    const button = renderer.root.findByType('Pressable');
    const card = renderer.root.findByType('View');
    act(() => button.props.onFocus());
    expect(flatten(card.props.style).borderColor).toBe('focus');
    expect(flatten(button.props.style({ pressed: false }))).toMatchObject({ borderWidth: 0, borderColor: 'transparent', outlineWidth: 0, outlineStyle: 'solid' });
    act(() => button.props.onBlur());
    expect(flatten(card.props.style).borderColor).toBe('divider');
});
it('keeps a visible keyboard focus boundary for a standalone project cover', () => {
    act(() => { renderer = TestRenderer.create(<GoalBoardButton variant="card" label="Project" onPress={() => {}}>Cover</GoalBoardButton>); });
    const button = renderer.root.findByType('Pressable');
    act(() => button.props.onFocus());
    expect(flatten(button.props.style({ pressed: false }))).toMatchObject({ borderWidth: 1, borderColor: 'focus' });
});
