import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalTask } from '@slopus/happy-wire';
import { ProjectTaskSwitcher } from './ProjectTaskSwitcher';
vi.mock('react-native', () => ({ Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', Platform: { OS: 'native' }, useWindowDimensions: () => ({ width: 1600, height: 900 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('react-native-unistyles', () => { const theme = { colors: { shadow: {}, surface: 'surface', divider: 'divider' } }; return { useUnistyles: () => ({ theme }), StyleSheet: { create: (f: any) => f(theme) } }; });
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: React.forwardRef((props: any, ref: any) => React.createElement('Button', { ...props, ref })) }));
const tasks = ['one', 'two'].map(id => ({ id, title: id, goal: `Goal ${id}` }) as GoalTask);
let renderer: any;
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
function setup() {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const select = vi.fn();
    act(() => { renderer = TestRenderer.create(<ProjectTaskSwitcher tasks={tasks} selectedId="one" onSelect={select} />, { createNodeMock: () => ({ measureInWindow: (f: any) => f(1240, 80, 100, 36), focus: vi.fn() }) }); });
    const press = (id: string) => act(() => renderer.root.findAllByType('Button').find((n: any) => n.props.testID === id).props.onPress());
    return { select, press };
}
describe('local task switching', () => {
    it('opens and dismisses the list without navigating away from the current workspace', () => {
        const { select, press } = setup();
        press('project-task-switcher');
        expect(renderer.root.findAllByType('Modal')).toHaveLength(1);
        expect(select).not.toHaveBeenCalled();
        act(() => renderer.root.findByType('Modal').props.onRequestClose());
        expect(renderer.root.findAllByType('Modal')).toHaveLength(0);
        expect(select).not.toHaveBeenCalled();
    });
    it('keeps the current task mounted when its selected row is clicked', () => {
        const { select, press } = setup();
        press('project-task-switcher'); press('project-task-switch-one');
        expect(select).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('Modal')).toHaveLength(0);
    });
    it('changes tasks only after explicitly choosing another row', () => {
        const { select, press } = setup();
        press('project-task-switcher'); press('project-task-switch-two');
        expect(select).toHaveBeenCalledExactlyOnceWith('two');
        expect(renderer.root.findAllByType('Modal')).toHaveLength(0);
    });
});
